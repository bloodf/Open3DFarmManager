import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  API_ENVELOPE_ISSUER,
  encodeApiEnvelopeFrame,
  newApiEnvelopeNonce,
  scopeForApiCommand,
  signApiEnvelope,
  type ApiEnvelopeCommandAction,
} from '../../packages/farm-protocol/src/api-envelope.ts'
import {
  closeCommandJournal,
  openCommandJournal,
  type CommandJournalHandle,
} from '../../packages/connector/src/control/command-journal.ts'
import { createPrinterBindingRegistry } from '../../packages/connector/src/control/printer-binding.ts'
import {
  createApiCommandRunner,
  type ApiCommandDriver,
  type ApiPrinterObservation,
} from '../../packages/connector/src/runtime/api-command.ts'

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

describe('speed modes at the API Connector', () => {
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
      speedModes?: readonly ('silent' | 'standard' | 'sport' | 'ludicrous')[]
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
      controls: () => options.controls ?? ['set_speed'],
      speedModes: () => options.speedModes,
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
          scopes: options.scopes ?? ['control:extended'],
        }),
        freshness: { freshAt: () => true },
      },
      report: (frame) => reports.push(JSON.parse(frame)),
    })
    return { runner, sent, reports, key: pair.privateKey }
  }

  it('refuses unadvertised speed before sending', async () => {
    const { runner, sent, key } = await harness({
      speedModes: ['silent', 'standard', 'sport'],
    })
    expect(
      await runner.run(
        await wire(key, { action: 'set_speed', args: { level: 'ludicrous' } }),
      ),
    ).toEqual({
      kind: 'refused',
      code: 'unsupported',
      detail: 'speed mode not supported by this printer',
    })
    expect(sent).toEqual([])
  })
  it('preserves default support when no modes are advertised', async () => {
    const { runner, sent, key } = await harness()
    expect(
      await runner.run(
        await wire(key, { action: 'set_speed', args: { level: 'ludicrous' } }),
      ),
    ).toEqual({ kind: 'completed' })
    expect(sent).toEqual([
      { action: 'set_speed', args: { level: 'ludicrous' } },
    ])
  })
})
