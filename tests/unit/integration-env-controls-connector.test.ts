// spec-derived, not captured — https://moonraker.readthedocs.io/en/latest/external_api/printer/
// Environment controls (#693) at the Connector: signed `environment:control`
// envelopes, interlocks and refusals. Only simulators and fakes; never a printer.
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  API_ENVELOPE_ISSUER,
  ApiEnvelopeAction,
  ApiEnvelopeV1,
  encodeApiEnvelopeFrame,
  newApiEnvelopeNonce,
  scopeForApiAction,
  scopeForApiCommand,
  signApiEnvelope,
  type ApiEnvelopeCommandAction,
} from '../../packages/farm-protocol/src/api-envelope.ts'
import {
  closeCommandJournal,
  openCommandJournal,
  readCommandAction,
  type CommandJournalHandle,
} from '../../packages/connector/src/control/command-journal.ts'
import type { ControlObservation } from '../../packages/connector/src/control/pause-dispatcher.ts'
import { createPrinterBindingRegistry } from '../../packages/connector/src/control/printer-binding.ts'
import {
  createApiCommandRunner,
  environmentInterlock,
  type ApiCommandDriver,
  type ApiPrinterObservation,
} from '../../packages/connector/src/runtime/api-command.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'
import { startMoonrakerMock } from '../../packages/sim-tools/src/mocks/moonraker-mock.ts'

const ids = {
  farm: randomUUID(),
  agent: randomUUID(),
  grant: randomUUID(),
  app: randomUUID(),
  assignment: randomUUID(),
}

async function keys() {
  return crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify'])
}

async function wire(
  key: CryptoKey,
  action: ApiEnvelopeCommandAction,
  scope = scopeForApiCommand(action.action),
) {
  const issuedAt = Date.now()
  return encodeApiEnvelopeFrame({
    v: 1,
    t: 'api-envelope.command',
    envelope: await signApiEnvelope(
      {
        v: 1,
        purpose: 'api-envelope',
        issuer: API_ENVELOPE_ISSUER,
        kind: 'action',
        kid: 'test',
        app_id: ids.app,
        grant_id: ids.grant,
        farm_id: ids.farm,
        agent_id: ids.agent,
        assignment_id: ids.assignment,
        resource_id: randomUUID(),
        cmd_id: randomUUID(),
        nonce: newApiEnvelopeNonce(),
        issued_at: issuedAt,
        expires_at: issuedAt + 20_000,
        scope,
        grant_epoch: issuedAt,
        action,
      },
      key,
    ),
  })
}

describe('environment envelope protocol', () => {
  it('signs environment actions under environment:control only', () => {
    expect(scopeForApiCommand('extraction_set')).toBe('environment:control')
    expect(scopeForApiCommand('plug_switch')).toBe('environment:control')
    expect(scopeForApiCommand('drying_start')).toBe('environment:control')
    expect(scopeForApiCommand('drying_stop')).toBe('environment:control')
    expect(scopeForApiCommand('set_fan')).toBe(scopeForApiAction('set_fan'))
    expect(scopeForApiCommand('pause')).toBe('control:basic')
  })

  it('keeps the existing API action set unchanged', () => {
    for (const action of [
      { action: 'extraction_set', args: { percent: 10 } },
      { action: 'plug_switch', args: { device: 'dryer', on: true } },
      { action: 'drying_stop', args: {} },
      { action: 'power', args: { device: 'printer', on: false } },
    ])
      expect(ApiEnvelopeAction.safeParse(action).success).toBe(false)
  })

  it('refuses malformed environment arguments in a signed envelope', () => {
    const base = {
      v: 1,
      purpose: 'api-envelope',
      issuer: API_ENVELOPE_ISSUER,
      kind: 'action',
      kid: 'test',
      app_id: ids.app,
      grant_id: ids.grant,
      farm_id: ids.farm,
      agent_id: ids.agent,
      assignment_id: ids.assignment,
      resource_id: randomUUID(),
      cmd_id: randomUUID(),
      nonce: newApiEnvelopeNonce(),
      issued_at: 1000,
      expires_at: 21_000,
    }
    for (const action of [
      { action: 'extraction_set', args: { percent: 101 } },
      { action: 'extraction_set', args: { percent: 50, fan: 'part' } },
      { action: 'plug_switch', args: { device: '../x', on: true } },
      {
        action: 'drying_start',
        args: { targetCelsius: 200, durationMinutes: 5 },
      },
    ])
      expect(ApiEnvelopeV1.safeParse({ ...base, action }).success).toBe(false)
    expect(
      ApiEnvelopeV1.safeParse({
        ...base,
        action: { action: 'extraction_set', args: { percent: 0 } },
      }).success,
    ).toBe(true)
  })
})

describe('environment interlocks', () => {
  const extraction = (percent: number) =>
    ({ action: 'extraction_set', args: { percent } }) as const
  const observed = (printState: string, ready = true) => ({
    ready,
    printState,
  })

  it('refuses when the state is unknown, never allows', () => {
    expect(environmentInterlock(extraction(50), null)).toEqual([
      'not-ready',
      'environment-interlock-state-unknown',
    ])
    expect(
      environmentInterlock(extraction(50), observed('idle', false)),
    ).toEqual(['not-ready', 'environment-interlock-state-unknown'])
    expect(environmentInterlock(extraction(50), observed('unknown'))?.[0]).toBe(
      'not-ready',
    )
    expect(environmentInterlock(extraction(50), observed('error'))?.[0]).toBe(
      'not-ready',
    )
  })

  it('never turns extraction off during a print, but may raise it', () => {
    for (const state of ['printing', 'paused'])
      expect(environmentInterlock(extraction(0), observed(state))).toEqual([
        'printer-busy',
        'extraction-interlock-print-active',
      ])
    expect(environmentInterlock(extraction(80), observed('printing'))).toBe(
      null,
    )
    expect(environmentInterlock(extraction(0), observed('idle'))).toBe(null)
  })

  it('never switches a smart plug during a print', () => {
    expect(
      environmentInterlock(
        { action: 'plug_switch', args: { device: 'dryer', on: false } },
        observed('printing'),
      ),
    ).toEqual(['printer-busy', 'plug-interlock-print-active'])
  })
})

describe('environment envelopes at the Connector', () => {
  let directory: string
  let journal: CommandJournalHandle
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'env-controls-connector-'))
    journal = openCommandJournal({ directory, clock: Date.now })
  })
  afterEach(async () => {
    closeCommandJournal(journal)
    await rm(directory, { recursive: true, force: true })
  })

  async function harness(
    options: {
      scopes?: string[]
      controls?: string[]
      observation?: ApiPrinterObservation | null
    } = {},
  ) {
    const pair = await keys()
    const sent: { action: string; args: unknown }[] = []
    const reports: unknown[] = []
    const registry = createPrinterBindingRegistry({
      allowedOrigins: ['http://127.0.0.1:7125'],
    })
    const binding = registry.provision({
      assignment_id: ids.assignment,
      farm_id: ids.farm,
      agent_id: ids.agent,
      printer_key: 'fake',
      moonraker_origin: 'http://127.0.0.1:7125',
    })
    const driver = {
      controls: () => options.controls ?? ['set_fan'],
      macros: () => [],
      macroParams: () => ({}),
      async execute(
        action: string,
        args: unknown,
        context: { beforeSend(): boolean },
      ) {
        if (!context.beforeSend()) return { acknowledged: false }
        sent.push({ action, args })
        return { acknowledged: true }
      },
    } as unknown as ApiCommandDriver
    const runner = createApiCommandRunner({
      farmId: ids.farm,
      agentId: ids.agent,
      journal,
      driver,
      clock: { wallNow: Date.now, monotonicNow: () => performance.now() },
      keys: { issuer: () => pair.publicKey },
      printer: () => binding,
      observe: () =>
        options.observation === undefined
          ? { ready: true, printState: 'printing' }
          : options.observation,
      grants: {
        lookup: () => ({
          grant_id: ids.grant,
          app_id: ids.app,
          farm_id: ids.farm,
          revoked: false,
          scopes: options.scopes ?? ['environment:control'],
        }),
        freshness: { freshAt: () => true },
      },
      report: (frame) => reports.push(JSON.parse(frame)),
    })
    return { runner, sent, reports, key: pair.privateKey }
  }

  it('applies extraction as the chamber fan and reports completed', async () => {
    const { runner, sent, reports, key } = await harness()
    const frame = await wire(key, {
      action: 'extraction_set',
      args: { percent: 60 },
    })
    expect(await runner.run(frame)).toEqual({ kind: 'completed' })
    expect(sent).toEqual([
      { action: 'set_fan', args: { fan: 'chamber', percent: 60 } },
    ])
    expect(reports).toMatchObject([{ outcome: 'completed' }])
    const cmdId = JSON.parse(frame).envelope.cmd_id
    expect(readCommandAction(journal, cmdId)).toBe('set_fan')
    // The same signed command is never executed twice.
    expect(await runner.run(frame)).toEqual({
      kind: 'dropped',
      reason: 'replay',
    })
    expect(sent).toHaveLength(1)
  })

  it('refuses turning extraction off during a print without sending', async () => {
    const { runner, sent, reports, key } = await harness()
    expect(
      await runner.run(
        await wire(key, { action: 'extraction_set', args: { percent: 0 } }),
      ),
    ).toEqual({
      kind: 'refused',
      code: 'printer-busy',
      detail: 'extraction-interlock-print-active',
    })
    expect(sent).toEqual([])
    expect(reports).toMatchObject([
      { outcome: 'refused', refusal_code: 'printer-busy' },
    ])
  })

  it('refuses on a stale or missing observation', async () => {
    const { runner, sent, key } = await harness({ observation: null })
    expect(
      await runner.run(
        await wire(key, { action: 'extraction_set', args: { percent: 40 } }),
      ),
    ).toEqual({
      kind: 'refused',
      code: 'not-ready',
      detail: 'environment-interlock-state-unknown',
    })
    expect(sent).toEqual([])
  })

  it('refuses smart plugs and drying as unsupported before journalling', async () => {
    const { runner, sent, key } = await harness({
      observation: { ready: true, printState: 'idle' },
      controls: ['set_fan', 'power'],
    })
    for (const action of [
      { action: 'plug_switch', args: { device: 'dryer', on: true } },
      {
        action: 'drying_start',
        args: { targetCelsius: 55, durationMinutes: 240 },
      },
      { action: 'drying_stop', args: {} },
    ] as const) {
      const frame = await wire(key, action)
      expect(await runner.run(frame)).toEqual({
        kind: 'refused',
        code: 'unsupported',
        detail: 'no qualified capability for this environment control',
      })
      expect(
        readCommandAction(journal, JSON.parse(frame).envelope.cmd_id),
      ).toBeNull()
    }
    expect(sent).toEqual([])
  })

  it('refuses a printer without a chamber fan control as unsupported', async () => {
    const { runner, sent, key } = await harness({ controls: ['pause'] })
    expect(
      await runner.run(
        await wire(key, { action: 'extraction_set', args: { percent: 40 } }),
      ),
    ).toMatchObject({ kind: 'refused', code: 'unsupported' })
    expect(sent).toEqual([])
  })

  it('refuses a grant without environment:control', async () => {
    const { runner, sent, key } = await harness({
      scopes: ['control:extended'],
    })
    expect(
      await runner.run(
        await wire(key, { action: 'extraction_set', args: { percent: 40 } }),
      ),
    ).toEqual({
      kind: 'refused',
      code: 'grant-revoked',
      detail: 'action outside the granted scope',
    })
    expect(sent).toEqual([])
  })

  it('refuses an environment action signed under another scope', async () => {
    const { runner, sent, key } = await harness({
      scopes: ['control:extended', 'environment:control'],
    })
    expect(
      await runner.run(
        await wire(
          key,
          { action: 'extraction_set', args: { percent: 40 } },
          'control:extended',
        ),
      ),
    ).toEqual({
      kind: 'refused',
      code: 'grant-revoked',
      detail: 'action outside the signed scope',
    })
    expect(sent).toEqual([])
  })
})

describe('environment envelopes against the Moonraker simulator', () => {
  it('sets the simulated chamber fan and keeps the interlock during a print', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'env-controls-sim-'))
    const journal = openCommandJournal({ directory, clock: Date.now })
    const probe = await startMoonrakerMock()
    let objects: string[]
    try {
      const listed = await fetch(new URL('/printer/objects/list', probe.origin))
      objects = (await listed.json()).result.objects
    } finally {
      await probe.close()
    }
    const mock = await startMoonrakerMock({
      initial: { state: 'standby' },
      objects: [...objects, 'fan_generic chamber'],
    })
    try {
      const pair = await keys()
      const clock = { wallNow: Date.now, monotonicNow: () => performance.now() }
      const registry = createPrinterBindingRegistry({
        allowedOrigins: [mock.origin],
      })
      const binding = registry.provision({
        assignment_id: ids.assignment,
        farm_id: ids.farm,
        agent_id: ids.agent,
        printer_key: 'simulated',
        moonraker_origin: mock.origin,
      })
      let observed: ControlObservation | null = null
      const router = createPauseDriverRouter({
        allowedOrigins: [mock.origin],
        limits: {
          maxMessageBytes: 4096,
          connectTimeoutMs: 500,
          requestTimeoutMs: 500,
          staleAfterMs: 2000,
          reconnectMinMs: 100,
          reconnectMaxMs: 100,
        },
        clock,
        observe(_binding, next) {
          observed = next
          return true
        },
      })
      const runner = createApiCommandRunner({
        farmId: ids.farm,
        agentId: ids.agent,
        journal,
        driver: router,
        clock,
        keys: { issuer: () => pair.publicKey },
        printer: () => binding,
        observe: () => observed,
        grants: {
          lookup: () => ({
            grant_id: ids.grant,
            app_id: ids.app,
            farm_id: ids.farm,
            revoked: false,
            scopes: ['environment:control'],
          }),
          freshness: { freshAt: () => true },
        },
        report() {},
      })
      // The Connector detects capabilities before it accepts commands.
      expect(await router.detect(binding)).toContain('set_fan')
      const chamberSpeed = async () => {
        const response = await fetch(
          new URL('/printer/objects/query?fan_generic%20chamber', mock.origin),
        )
        return (await response.json()).result.status['fan_generic chamber']
          .speed as number
      }
      expect(
        await runner.run(
          await wire(pair.privateKey, {
            action: 'extraction_set',
            args: { percent: 60 },
          }),
        ),
      ).toEqual({ kind: 'completed' })
      expect(await chamberSpeed()).toBeCloseTo(0.6, 2)

      mock.control.update({ state: 'printing', filename: 'part.gcode' })
      expect(
        await runner.run(
          await wire(pair.privateKey, {
            action: 'extraction_set',
            args: { percent: 0 },
          }),
        ),
      ).toEqual({
        kind: 'refused',
        code: 'printer-busy',
        detail: 'extraction-interlock-print-active',
      })
      expect(await chamberSpeed()).toBeCloseTo(0.6, 2)
    } finally {
      await mock.close()
      closeCommandJournal(journal)
      await rm(directory, { recursive: true, force: true })
    }
  }, 15_000)
})
