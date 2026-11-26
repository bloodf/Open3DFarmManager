/**
 * #937: emergency_stop needs its own scope, and the Connector enforces it. The
 * driver is a recorder: nothing here reaches a printer.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import {
  API_ENVELOPE_ISSUER,
  decodeApiEnvelopeResultFrame,
  encodeApiEnvelopeFrame,
  newApiEnvelopeNonce,
  scopeForApiAction,
  signApiEnvelope,
} from '../../packages/farm-protocol/src/api-envelope.ts'
import type { SignallingServerFrame } from '../../packages/farm-protocol/src/signalling-socket.ts'
import { createOfflineAuthority } from '../../packages/connector/src/auth/offline-authority.ts'
import {
  closeCommandJournal,
  openCommandJournal,
} from '../../packages/connector/src/control/command-journal.ts'
import { createPrinterBindingRegistry } from '../../packages/connector/src/control/printer-binding.ts'
import { receiveApiCommand } from '../../packages/connector/src/runtime/api-command.ts'

type Scope = Extract<
  SignallingServerFrame,
  { t: 'connector.api-command' }
>['scope']

const ORIGIN = 'http://127.0.0.1:7125'

/** One emergency_stop envelope delivered over a fresh inbox. */
async function deliver(t: TestContext, signed: Scope | null, inbox: Scope) {
  const issuer = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const directory = mkdtempSync(join(tmpdir(), 'fix-937-'))
  const now = Date.now()
  const journal = openCommandJournal({ directory, clock: () => now })
  t.after(() => {
    closeCommandJournal(journal)
    rmSync(directory, { recursive: true, force: true })
  })
  const farm = randomUUID()
  const agent = randomUUID()
  const assignment = randomUUID()
  const binding = createPrinterBindingRegistry({
    allowedOrigins: [ORIGIN],
  }).provision({
    assignment_id: assignment,
    farm_id: farm,
    agent_id: agent,
    printer_key: 'printer-1',
    moonraker_origin: ORIGIN,
  })
  const envelope = await signApiEnvelope(
    {
      v: 1,
      purpose: 'api-envelope',
      issuer: API_ENVELOPE_ISSUER,
      kid: 'api-1',
      app_id: randomUUID(),
      grant_id: randomUUID(),
      farm_id: farm,
      agent_id: agent,
      assignment_id: assignment,
      resource_id: randomUUID(),
      cmd_id: randomUUID(),
      nonce: newApiEnvelopeNonce(),
      issued_at: now,
      expires_at: now + 60_000,
      ...(signed ? { scope: signed, grant_epoch: now } : {}),
      kind: 'action',
      action: { action: 'emergency_stop', args: {} },
    },
    issuer.privateKey,
  )
  const authority = createOfflineAuthority()
  authority.confirm({ wall: now, mono: 1 }, 1)
  const writes: string[] = []
  const reports: ReturnType<typeof decodeApiEnvelopeResultFrame>[] = []
  const result = await receiveApiCommand(
    {
      farmId: farm,
      agentId: agent,
      keys: { issuer: () => issuer.publicKey },
      journal,
      printer: (id) => (id === assignment ? binding : undefined),
      observe: () => ({ ready: true, printState: 'printing' }),
      driver: {
        prepare: async () => ({ connectionGeneration: 1 }),
        controls: () => ['emergency_stop'],
        async execute(action, _args, input) {
          if (!input.beforeSend()) return { acknowledged: false }
          writes.push(action)
          return { acknowledged: true }
        },
      },
      clock: { wallNow: () => now, monotonicNow: () => 1 },
    },
    {
      v: 1,
      t: 'connector.api-command',
      wire: encodeApiEnvelopeFrame({
        v: 1,
        t: 'api-envelope.command',
        envelope,
      }),
      scope: inbox,
      confirmed_at: now,
    },
    {
      signal: new AbortController().signal,
      report: (wire) => reports.push(decodeApiEnvelopeResultFrame(wire)),
      freshness: authority.freshness,
    },
  )
  return { result, writes, report: reports.at(-1) }
}

test('emergency_stop maps to its own scope', () => {
  assert.equal(scopeForApiAction('emergency_stop'), 'control:emergency')
})

for (const [name, signed, inbox] of [
  ['an old server signs control:extended', 'control:extended'] as const,
  ['a signed control:basic', 'control:basic'] as const,
  ['an unsigned scope over a control:extended inbox', null] as const,
  [
    'a control:emergency claim over a control:extended inbox',
    'control:emergency',
    'control:extended',
  ] as const,
].map(
  ([name, signed, inbox]) =>
    [name, signed, inbox ?? signed ?? 'control:extended'] as const,
))
  test(`emergency_stop is refused before any write: ${name}`, async (t) => {
    const { result, writes, report } = await deliver(t, signed, inbox)
    assert.equal(result.kind, 'refused')
    assert.equal(result.kind === 'refused' && result.code, 'grant-revoked')
    assert.deepEqual(writes, [])
    assert.equal(report?.outcome, 'refused')
    assert.equal(
      report?.message,
      'Parada de emergência recusada: o aplicativo precisa do escopo control:emergency, concedido pelo proprietário.',
    )
  })

test('emergency_stop scoped control:emergency is written once', async (t) => {
  const { result, writes, report } = await deliver(
    t,
    'control:emergency',
    'control:emergency',
  )
  assert.deepEqual(result, { kind: 'completed' })
  assert.deepEqual(writes, ['emergency_stop'])
  assert.equal(report?.outcome, 'completed')
})
