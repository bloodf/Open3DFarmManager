import test from 'node:test'
import assert from 'node:assert/strict'
import type { Sql, TransactionSql } from 'postgres'
import { randomUUID } from 'node:crypto'
import { PostgresSignallingAuthorization } from '../../apps/farm/server/storage/postgres-signalling-authorization.ts'
import { SignallingRuntime } from '../../apps/farm/server/services/signalling-runtime.ts'
import { connectorKeyBinding } from '../../apps/farm/server/utils/connector-credentials.ts'
import { base64url } from '../../packages/farm-protocol/src/encoding.ts'
import { createOfflineAuthority } from '../../packages/connector/src/auth/offline-authority.ts'
import { runSignallingLifecycle } from '../../packages/connector/src/runtime/signalling.ts'
import { fixture, flush } from '../helpers/signalling-runtime-fixture.ts'

const config = {
  issuer: 'farm',
  origin: 'https://farm.example',
  audience: 'https://farm.example',
  idleTimeoutMs: 1_800_000,
}

async function database() {
  const key = await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])
  const spki = base64url(
    new Uint8Array(await crypto.subtle.exportKey('spki', key.publicKey)),
  )
  const binding = await connectorKeyBinding(spki)
  const scope = {
    agentId: randomUUID(),
    farmId: randomUUID(),
    jti: randomUUID(),
  }
  let mode: 'authorized' | 'denied' | 'unavailable' = 'authorized'
  let queries = 0
  const tx = async (parts: TemplateStringsArray) => {
    queries++
    if (mode === 'unavailable') throw new Error('simulated connection reset')
    const query = parts.join('?')
    if (query.includes('clock_timestamp')) return [{ observed_at: 100_000 }]
    if (query.includes('connector_enrollments'))
      return [
        {
          farm_id: scope.farmId,
          public_key_spki: spki,
          fingerprint: binding.fingerprint,
          status: 'approved',
        },
      ]
    if (query.includes('connector_credentials'))
      return [
        {
          jti: scope.jti,
          farm_id: scope.farmId,
          fingerprint: binding.fingerprint,
          thumbprint: binding.thumbprint,
          issuer: config.issuer,
          audience: config.audience,
          issued_at: 1,
          expires_at: 200,
        },
      ]
    if (query.includes('connector_revocations'))
      return mode === 'denied' ? [{ agent_id: scope.agentId }] : []
    return []
  }
  const sql = {
    begin: async (run: (tx: TransactionSql) => unknown) =>
      run(tx as unknown as TransactionSql),
  } as unknown as Sql
  const reader = new PostgresSignallingAuthorization(sql, config, {
    wall: () => 100_000,
    monotonic: () => 1000,
  })
  return {
    reader,
    scope,
    setMode(value: typeof mode) {
      mode = value
    },
    queries: () => queries,
  }
}

test('reader distinguishes authorized, definitive revocation and an injected failing query', async () => {
  const db = await database()
  const authorized = await db.reader.readConnectorCurrent(db.scope)
  assert.equal(authorized.kind, 'authorized')
  assert.ok(authorized.kind === 'authorized')
  assert.equal(authorized.snapshot.identity.credential_jti, db.scope.jti)
  db.setMode('denied')
  assert.deepEqual(await db.reader.readConnectorCurrent(db.scope), {
    kind: 'denied',
  })
  const before = db.queries()
  db.setMode('unavailable')
  assert.deepEqual(await db.reader.readConnectorCurrent(db.scope), {
    kind: 'unavailable',
  })
  assert.ok(db.queries() > before)
  assert.deepEqual(await db.reader.readConnectorCurrent({}), { kind: 'denied' })
})

test('unavailable rereads skip confirmation and expire locally; recovered reads confirm and real revocation closes', async (t) => {
  const db = await database()
  let unavailable = false
  const f = await fixture(
    (config) =>
      new SignallingRuntime({
        ...config,
        reader: {
          ...config.reader,
          readConnectorCurrent: (scope) =>
            unavailable
              ? db.reader.readConnectorCurrent(scope)
              : config.reader.readConnectorCurrent(scope),
        },
      }),
  )
  t.after(() => f.close())
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const inbox = await f.inbox()
  const initial = inbox.wires.at(-1)
  assert.ok(initial?.t === 'connector.authority-confirm')
  let elapsed = 0
  const sample = () => ({ wall: 100_000 + elapsed, mono: 1000 + elapsed })
  const authority = createOfflineAuthority({ maxAgeMs: 15_000 })
  assert.equal(authority.confirm(sample(), initial.server_seq), true)
  unavailable = true
  db.setMode('unavailable')
  const advance = async () => {
    elapsed += 5000
    f.advance(5000)
    t.mock.timers.tick(5000)
    await flush()
  }
  for (let i = 0; i < 3; i++) {
    await advance()
    assert.equal(inbox.raw.socket.destroyed, false)
    assert.equal(
      inbox.wires.filter((w) => w.t === 'connector.authority-confirm').length,
      1,
    )
    assert.equal(
      inbox.wires.some((w) => w.t === 'connector.authority-revoked'),
      false,
    )
    assert.equal(authority.freshness.freshAt(sample()), i < 2)
  }
  assert.ok(db.queries() >= 3)
  unavailable = false
  await advance()
  const recovered = inbox.wires.at(-1)
  assert.ok(recovered?.t === 'connector.authority-confirm')
  assert.equal(authority.confirm(sample(), recovered.server_seq), true)
  f.revoke()
  await advance()
  const revoked = inbox.wires.at(-1)
  assert.ok(revoked?.t === 'connector.authority-revoked')
  authority.revoke(revoked.server_seq)
  assert.equal(authority.freshness.freshAt(sample()), false)
  assert.equal(authority.confirm(sample(), recovered.server_seq), false)
  assert.equal(inbox.raw.socket.destroyed, true)
})

test('immediately revoked admitted inboxes retry exponentially up to retryMaxMs with injected time', async () => {
  const controller = new AbortController()
  let clock = 100_000
  const delays: number[] = []
  let disposed = 0
  await runSignallingLifecycle({
    signal: controller.signal,
    credentialExpiresAt: clock + 1_000_000,
    retryMinMs: 1000,
    retryMaxMs: 8000,
    now: () => clock,
    monotonic: () => clock,
    sleep: async (ms) => {
      delays.push(ms)
      clock += ms
      if (delays.length === 6) controller.abort()
    },
    createSession(terminal, admitted) {
      return {
        start: async () => {
          admitted()
          terminal()
          admitted()
        },
        close() {},
        dispose: async () => {
          disposed++
        },
      }
    },
  })
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 8000, 8000])
  assert.equal(disposed, 6)
})

test('sustained admitted uptime restores the minimum retry delay', async () => {
  const controller = new AbortController()
  let clock = 100_000
  let attempts = 0
  const delays: number[] = []
  await runSignallingLifecycle({
    signal: controller.signal,
    credentialExpiresAt: clock + 1_000_000,
    retryMinMs: 1000,
    retryMaxMs: 8000,
    now: () => clock,
    monotonic: () => clock,
    sleep: async (ms) => {
      delays.push(ms)
      clock += ms
      if (delays.length === 4) controller.abort()
    },
    createSession(terminal, admitted) {
      return {
        start: async () => {
          admitted()
          if (++attempts === 4) clock += 30_000
          terminal()
        },
        close() {},
        dispose: async () => {},
      }
    },
  })
  assert.deepEqual(delays, [1000, 2000, 4000, 1000])
})
