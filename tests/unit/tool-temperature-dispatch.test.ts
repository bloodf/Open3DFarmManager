import type { ToolHeaters } from '../../packages/farm-protocol/src/state.ts'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import {
  API_ENVELOPE_ISSUER,
  encodeApiEnvelopeFrame,
  newApiEnvelopeNonce,
  signApiEnvelope,
} from '../../packages/farm-protocol/src/api-envelope.ts'
import {
  closeCommandJournal,
  openCommandJournal,
  readCommandAction,
} from '../../packages/connector/src/control/command-journal.ts'
import { createPrinterBindingRegistry } from '../../packages/connector/src/control/printer-binding.ts'
import { createApiCommandRunner } from '../../packages/connector/src/runtime/api-command.ts'

async function fixture(
  options: {
    state?: string | null
    heaters?: ToolHeaters
    target?: number
    scope?: string
    changeAtSend?: boolean
    loseAck?: boolean
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'tool-temperature-'))
  const journal = openCommandJournal({ directory, clock: Date.now })
  const pair = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const farm = randomUUID(),
    agent = randomUUID(),
    grant = randomUUID(),
    app = randomUUID(),
    assignment = randomUUID(),
    cmdId = randomUUID()
  const binding = createPrinterBindingRegistry({
    allowedOrigins: ['http://127.0.0.1:7125'],
  }).provision({
    farm_id: farm,
    agent_id: agent,
    assignment_id: assignment,
    printer_key: 'fake',
    moonraker_origin: 'http://127.0.0.1:7125',
  })
  let heaters = options.heaters
  const sent = vi.fn()
  const runner = createApiCommandRunner({
    farmId: farm,
    agentId: agent,
    journal,
    keys: { issuer: () => pair.publicKey },
    grants: {
      lookup: () => ({
        grant_id: grant,
        app_id: app,
        farm_id: farm,
        revoked: false,
        scopes: [options.scope ?? 'control:extended'],
      }),
      freshness: { freshAt: () => true },
    },
    printer: () => binding,
    observe: () =>
      options.state === null
        ? null
        : {
            ready: true,
            printState: options.state ?? 'idle',
            toolHeaters: heaters,
          },
    clock: { wallNow: Date.now, monotonicNow: () => performance.now() },
    report: () => {},
    driver: {
      controls: () => ['set_tool_temperature'],
      async execute(action, args, { beforeSend }) {
        if (options.changeAtSend) heaters = []
        if (!beforeSend()) return { acknowledged: false }
        sent(action, args)
        if (options.loseAck) throw new Error('lost acknowledgement')
        return { acknowledged: true }
      },
    },
  })
  const now = Date.now()
  const wire = encodeApiEnvelopeFrame({
    v: 1,
    t: 'api-envelope.command',
    envelope: await signApiEnvelope(
      {
        v: 1,
        purpose: 'api-envelope',
        issuer: API_ENVELOPE_ISSUER,
        kind: 'action',
        kid: 'test',
        app_id: app,
        grant_id: grant,
        farm_id: farm,
        agent_id: agent,
        assignment_id: assignment,
        resource_id: randomUUID(),
        cmd_id: cmdId,
        nonce: newApiEnvelopeNonce(),
        issued_at: now,
        expires_at: now + 20000,
        scope: 'control:extended',
        grant_epoch: now,
        action: {
          action: 'set_tool_temperature',
          args: { tool: 1, target_c: options.target ?? 200 },
        },
      },
      pair.privateKey,
    ),
  })
  return {
    runner,
    wire,
    sent,
    journal,
    cmdId,
    directory,
    async close() {
      closeCommandJournal(journal)
      await rm(directory, { recursive: true, force: true })
    },
  }
}

describe('tool temperature API admission', () => {
  test.each<[NonNullable<Parameters<typeof fixture>[0]>, string]>([
    [{}, 'tool-heater-not-advertised'],
    [{ heaters: [{ tool: 1, maxC: 199 }] }, 'tool-temperature-above-maximum'],
    [{ heaters: [{ tool: 1, maxC: 250 }], state: null }, 'tool-state-stale'],
    ...['printing', 'paused', 'error', 'unknown', 'cancelled'].map(
      (state) =>
        [
          { heaters: [{ tool: 1, maxC: 250 }], state },
          'tool-printer-not-idle',
        ] as [NonNullable<Parameters<typeof fixture>[0]>, string],
    ),
    [
      { heaters: [{ tool: 1, maxC: 250 }], scope: 'control:basic' },
      'action outside the granted scope',
    ],
    [
      { heaters: [{ tool: 1, maxC: 250 }], changeAtSend: true },
      'tool-heater-not-advertised',
    ],
  ])('refuses without a send: %s', async (options, detail) => {
    const f = await fixture(options)
    try {
      expect(await f.runner.run(f.wire)).toMatchObject({
        kind: 'refused',
        detail,
      })
      expect(f.sent).not.toHaveBeenCalled()
    } finally {
      await f.close()
    }
  })
  test('delivers once to an idle advertised tool and records the action', async () => {
    const f = await fixture({ heaters: [{ tool: 1, maxC: 200 }] })
    try {
      expect(await f.runner.run(f.wire)).toEqual({ kind: 'completed' })
      expect(f.sent).toHaveBeenCalledOnce()
      expect(f.sent).toHaveBeenCalledWith('set_tool_temperature', {
        tool: 1,
        target_c: 200,
      })
      expect(readCommandAction(f.journal, f.cmdId)).toBe('set_tool_temperature')
      const db = new DatabaseSync(join(f.directory, 'pause-commands.sqlite'))
      try {
        expect(
          db
            .prepare(
              'SELECT tool,target_c FROM control_tool_temperature_args WHERE cmd_id=?',
            )
            .get(f.cmdId),
        ).toMatchObject({ tool: 1, target_c: 200 })
      } finally {
        db.close()
      }
      expect(await f.runner.run(f.wire)).toEqual({
        kind: 'dropped',
        reason: 'replay',
      })
    } finally {
      await f.close()
    }
  })
  test('never replays an uncertain send', async () => {
    const f = await fixture({
      heaters: [{ tool: 1, maxC: 250 }],
      loseAck: true,
    })
    try {
      expect(await f.runner.run(f.wire)).toMatchObject({
        kind: 'outcome-unknown',
      })
      expect(await f.runner.run(f.wire)).toEqual({
        kind: 'dropped',
        reason: 'replay',
      })
      expect(f.sent).toHaveBeenCalledOnce()
    } finally {
      await f.close()
    }
  })
})
