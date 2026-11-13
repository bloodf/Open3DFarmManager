import { ConfigurationChallengeRecord } from '../../apps/farm/server/services/configuration-authority-contract.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import { deriveConfigurationAssignmentIdentity } from '../../packages/farm-protocol/src/configuration-inventory.ts'
import { connectorKeyBinding } from '../../apps/farm/server/utils/connector-credentials.ts'
import { describe, it, expect, vi } from 'vitest'
import type { Sql } from 'postgres'
import { PostgresConfigurationStore } from '../../apps/farm/server/storage/postgres-configuration.ts'

const scope = {
  sessionRecordId: 'synthetic-session',
  farmId: '11111111-1111-4111-8111-111111111111',
  agentId: '22222222-2222-4222-8222-222222222222',
  keyId: '33333333-3333-4333-8333-333333333333',
}
const config = {
  origin: 'https://farm.example',
  audience: 'farm',
  credentialIssuer: 'farm',
  credentialAudience: 'connector',
  idleTimeoutMs: 1800000,
}
const operation = {
  operation_id: '44444444-4444-4444-8444-444444444444',
  account_id: 'synthetic-account',
  farm_id: scope.farmId,
  agent_id: scope.agentId,
  key_id: scope.keyId,
  expected_revision: 0,
  target_sha256: 'A'.repeat(43),
  commit_sha256: null,
  created_at: 1000,
}
// Synthetic SQL boundary: executes the real adapter callback and models commit/rollback;
// it does not qualify PostgreSQL locking, grants, triggers or isolation.
function database(rows: Record<string, unknown[]> = {}) {
  let committed = new Map<string, unknown>()
  const statements: string[] = []
  const pool = {
    async begin(level: string, work: (tx: unknown) => Promise<void>) {
      expect(level).toBe('isolation level serializable')
      const pending = new Map(committed)
      const tx = async (parts: TemplateStringsArray, ...values: unknown[]) => {
        const text = parts.join('?')
        statements.push(text)
        for (const [pattern, result] of Object.entries(rows)) {
          if (text.includes(pattern)) return result
        }
        if (text.includes('observe_signalling_session_expiry'))
          return [{ now: 1000 }]
        if (text.includes('INSERT INTO farm.configuration_operations')) {
          if (pending.has(String(values[0]))) return []
          pending.set(String(values[0]), JSON.parse(String(values[1])))
          return [{ operation_id: values[0] }]
        }
        if (text.includes('SELECT record FROM farm.configuration_operations')) {
          const record = pending.get(String(values[0]))
          return record ? [{ record }] : []
        }
        if (text.includes('INSERT INTO farm.configuration_challenges')) {
          const record = JSON.parse(String(values[3]))
          for (const value of pending.values()) {
            const parsed = ConfigurationChallengeRecord.safeParse(value)
            if (
              parsed.success &&
              (parsed.data.challenge.challenge_id === values[0] ||
                parsed.data.challenge.capability_id === values[1] ||
                parsed.data.challenge.admission_nonce === values[2])
            )
              return []
          }
          pending.set(`challenge:${values[0]}`, record)
          return [{ challenge_id: values[0] }]
        }
        if (text.includes('UPDATE farm.configuration_challenges')) {
          const key = `challenge:${values[0]}`
          const record = pending.get(key)
          if (!record || pending.has(`consumed:${values[0]}`)) return []
          pending.set(`consumed:${values[0]}`, true)
          return [{ record }]
        }
        if (text.includes('INSERT INTO farm.printer_assignments')) {
          const idKey = `assignment-id:${values[0]}`
          const key = `assignment:${values[1]}:${values[3]}`
          if (pending.has(idKey) || pending.has(key)) return []
          pending.set(idKey, values[3])
          pending.set(key, values[0])
          return [{ id: values[0] }]
        }
        if (text.includes('INSERT INTO farm.configuration_receipts')) {
          pending.set(`receipt:${values[0]}`, {
            record: JSON.parse(String(values[3])),
            assignment_id: values[2],
          })
          return []
        }
        if (text.includes('SELECT record,assignment_id::text')) {
          const value = pending.get(`receipt:${values[0]}`)
          return value ? [value] : []
        }
        return []
      }
      await work(tx)
      committed = pending
    },
  }
  return { pool: pool as unknown as Sql, statements }
}
describe('production configuration store through synthetic SQL', () => {
  it('denies a missing/revoked session rather than granting a default role', async () => {
    const db = database()
    const store = new PostgresConfigurationStore(db.pool, config)
    expect(await store.read(scope)).toBeNull()
    expect(db.statements.some((s) => s.includes('session_accounts'))).toBe(true)
  })
  it('persists operations across adapter restart and rejects reused identity', async () => {
    const db = database()
    const store = new PostgresConfigurationStore(db.pool, config)
    await store.transaction(scope, async (tx) => {
      expect(await tx.createOperation(operation)).toBe(true)
    })
    const restarted = new PostgresConfigurationStore(db.pool, config)
    await restarted.transaction(scope, async (tx) => {
      expect(await tx.operation(operation.operation_id)).toEqual(operation)
      expect(await tx.createOperation(operation)).toBe(false)
    })
  })
  it('rolls back writes when callback rejects', async () => {
    const db = database()
    const store = new PostgresConfigurationStore(db.pool, config)
    await expect(
      store.transaction(scope, async (tx) => {
        await tx.createOperation(operation)
        throw new Error('synthetic failure')
      }),
    ).rejects.toThrow('synthetic failure')
    await store.transaction(scope, async (tx) => {
      expect(await tx.operation(operation.operation_id)).toBeNull()
    })
  })
  it('rejects malformed scope before SQL', async () => {
    const db = database()
    const store = new PostgresConfigurationStore(db.pool, config)
    await expect(store.read({ ...scope, farmId: 'invalid' })).rejects.toThrow()
    expect(db.statements).toHaveLength(0)
  })
})

async function authorityFixture() {
  const browser = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )
  const jwk = await crypto.subtle.exportKey('jwk', browser.publicKey)
  const validated = await validateBrowserDevicePublicKey({
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
  })
  const connector = await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])
  const spki = Buffer.from(
    await crypto.subtle.exportKey('spki', connector.publicKey),
  ).toString('base64url')
  const binding = await connectorKeyBinding(spki)
  const rows: Record<string, unknown[]> = {
    'SELECT id,session_version': [
      { id: 'synthetic-account', sessionVersion: 0, disabled: false },
    ],
    'SELECT id,account_id': [
      {
        id: scope.sessionRecordId,
        accountId: 'synthetic-account',
        accountVersion: 0,
        createdAt: 0,
        lastSeenAt: 0,
        absoluteExpiresAt: 100000,
        revokedAt: null,
      },
    ],
    'SELECT role,revoked_at': [{ role: 'owner', revoked_at: null }],
    'SELECT status,public_key': [
      {
        status: 'approved',
        public_key: validated.publicKey,
        thumbprint: validated.thumbprint,
        approved_at: 0,
        revoked_at: null,
      },
    ],
    'SELECT farm_id,status': [
      {
        farm_id: scope.farmId,
        status: 'approved',
        public_key_spki: spki,
        fingerprint: binding.fingerprint,
      },
    ],
    'SELECT jti,farm_id': [
      {
        jti: '55555555-5555-4555-8555-555555555555',
        farm_id: scope.farmId,
        fingerprint: binding.fingerprint,
        thumbprint: binding.thumbprint,
        issuer: 'farm',
        audience: 'connector',
        issued_at: 0,
        expires_at: 100,
      },
    ],
  }
  return { rows, ...database(rows) }
}
it('checks current durable role, account, credential and revocation on each transaction', async () => {
  const db = await authorityFixture()
  const store = new PostgresConfigurationStore(db.pool, config)
  expect((await store.read(scope))?.authority.role).toBe('owner')
  db.rows['SELECT role,revoked_at'] = [{ role: 'viewer', revoked_at: null }]
  expect(await store.read(scope)).toBeNull()
  db.rows['SELECT role,revoked_at'] = [{ role: 'owner', revoked_at: null }]
  db.rows['SELECT agent_id FROM farm.connector_revocations'] = [
    { agent_id: scope.agentId },
  ]
  expect(await store.read(scope)).toBeNull()
  delete db.rows['SELECT agent_id FROM farm.connector_revocations']
  db.rows['SELECT id,account_id'] = [
    {
      id: scope.sessionRecordId,
      accountId: 'different-account',
      accountVersion: 0,
      createdAt: 0,
      lastSeenAt: 0,
      absoluteExpiresAt: 100000,
      revokedAt: null,
    },
  ]
  expect(await store.read(scope)).toBeNull()
})
it('rejects expired credentials and revoked browser keys', async () => {
  const db = await authorityFixture()
  const store = new PostgresConfigurationStore(db.pool, config)
  db.rows['SELECT observed_at'] = [
    { observed_at: 1000, credential_expired_at: 1000 },
  ]
  expect(await store.read(scope)).toBeNull()
  delete db.rows['SELECT observed_at']
  db.rows['SELECT status,public_key'] = []
  expect(await store.read(scope)).toBeNull()
})

it('registers one canonical assignment, preserves Moonraker rows, and returns the same assignment after restart; conflicts do not create printers', async () => {
  const db = await authorityFixture()
  const store = new PostgresConfigurationStore(db.pool, config)
  const identity = await deriveConfigurationAssignmentIdentity({
    account_id: operation.account_id,
    farm_id: scope.farmId,
    agent_id: scope.agentId,
    bridge_instance_id: 'bridge-1',
    device_id: 'synthetic-printer',
  })
  const record = {
    operation_id: operation.operation_id,
    receipt_sha256: 'A'.repeat(43),
    receipt_wire: 'synthetic-signed-receipt',
    farm_id: scope.farmId,
    agent_id: scope.agentId,
    account_id: operation.account_id,
    bridge_instance_id: 'bridge-1',
    device_id: 'synthetic-printer',
    assignment_id: identity.assignment_id,
    printer_key: identity.printer_key,
    committed_revision: 1,
    registered_at: 1000,
  }
  await store.transaction(scope, async (tx) => {
    await tx.createOperation({ ...operation, commit_sha256: 'A'.repeat(43) })
  })
  const first = await store.transaction(scope, (tx) =>
    tx.registerReceipt(record),
  )
  expect(first).toEqual({ ok: true, assignmentId: identity.assignment_id })
  const restarted = new PostgresConfigurationStore(db.pool, config)
  expect(
    await restarted.transaction(scope, (tx) =>
      tx.registerReceipt({ ...record, registered_at: 1001 }),
    ),
  ).toEqual(first)
  expect(
    await restarted.transaction(scope, (tx) =>
      tx.registerReceipt({
        ...record,
        assignment_id: '99999999-9999-4999-8999-999999999999',
      }),
    ),
  ).toEqual({ ok: false })
  expect(
    await restarted.transaction(scope, (tx) =>
      tx.registerReceipt({ ...record, device_id: 'conflict' }),
    ),
  ).toEqual({ ok: false })
  expect(
    await restarted.transaction(scope, (tx) =>
      tx.registerReceipt({ ...record, committed_revision: 2 }),
    ),
  ).toEqual({ ok: false })
  expect(
    db.statements.filter((s) =>
      s.includes('INSERT INTO farm.printer_assignments'),
    ),
  ).toHaveLength(1)
  // Pre-existing Moonraker assignment in the same farm does not conflict, while a
  // pre-existing conflicting canonical binding for a second operation is rejected.
  const otherDevice = await deriveConfigurationAssignmentIdentity({
    account_id: operation.account_id,
    farm_id: scope.farmId,
    agent_id: scope.agentId,
    bridge_instance_id: 'bridge-1',
    device_id: 'occupied-printer',
  })
  const conflictOpId = '99999999-9999-4999-8999-999999999990'
  const conflictHash = 'B'.repeat(42) + 'E'
  await store.transaction(scope, async (tx) => {
    await tx.createOperation({
      ...operation,
      operation_id: conflictOpId,
      commit_sha256: conflictHash,
    })
  })
  // Seed pre-existing Moonraker row and occupied canonical printer key through raw pool.
  await db.pool.begin('isolation level serializable', async (raw) => {
    const sql = raw as unknown as (
      parts: TemplateStringsArray,
      ...values: unknown[]
    ) => Promise<unknown[]>
    await sql`INSERT INTO farm.printer_assignments(id,farm_id,agent_id,printer_key,created_at,created_by) VALUES (${'99999999-9999-4999-8999-999999999991'}::uuid,${scope.farmId}::uuid,${scope.agentId}::uuid,${'voron-moonraker-1'},1000,${operation.account_id}) ON CONFLICT DO NOTHING RETURNING id`
    await sql`INSERT INTO farm.printer_assignments(id,farm_id,agent_id,printer_key,created_at,created_by) VALUES (${otherDevice.assignment_id}::uuid,${scope.farmId}::uuid,${scope.agentId}::uuid,${otherDevice.printer_key},1000,${'foreign-account'}) ON CONFLICT DO NOTHING RETURNING id`
  })
  expect(
    await store.transaction(scope, (tx) =>
      tx.registerReceipt({
        ...record,
        operation_id: conflictOpId,
        receipt_sha256: conflictHash,
        device_id: 'occupied-printer',
        assignment_id: otherDevice.assignment_id,
        printer_key: otherDevice.printer_key,
      }),
    ),
  ).toEqual({ ok: false })
})
it('rolls back assignment and receipt together after a transaction failure', async () => {
  const db = await authorityFixture()
  const store = new PostgresConfigurationStore(db.pool, config)
  await store.transaction(scope, async (tx) => {
    await tx.createOperation({ ...operation, commit_sha256: 'A'.repeat(43) })
  })
  const identity = await deriveConfigurationAssignmentIdentity({
    account_id: operation.account_id,
    farm_id: scope.farmId,
    agent_id: scope.agentId,
    bridge_instance_id: 'bridge-1',
    device_id: 'synthetic-printer',
  })
  const record = {
    operation_id: operation.operation_id,
    receipt_sha256: 'A'.repeat(43),
    receipt_wire: 'synthetic-signed-receipt',
    farm_id: scope.farmId,
    agent_id: scope.agentId,
    account_id: operation.account_id,
    bridge_instance_id: 'bridge-1',
    device_id: 'synthetic-printer',
    assignment_id: identity.assignment_id,
    printer_key: identity.printer_key,
    committed_revision: 1,
    registered_at: 1000,
  }
  await expect(
    store.transaction(scope, async (tx) => {
      expect((await tx.registerReceipt(record)).ok).toBe(true)
      throw new Error('lost transaction')
    }),
  ).rejects.toThrow('lost transaction')
  expect(
    (await store.transaction(scope, (tx) => tx.registerReceipt(record))).ok,
  ).toBe(true)
})

it('executes the production plugin disabled path without opening pools', async () => {
  vi.stubGlobal('defineNitroPlugin', (callback: unknown) => callback)
  vi.doMock('nuxt/server', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    useRuntimeConfig: () => ({}),
  }))
  const saved = process.env.OPEN3DFARM_CONFIGURATION
  delete process.env.OPEN3DFARM_CONFIGURATION
  try {
    const modulePath =
      '../../apps/farm/server/plugins/configuration-lifecycle.ts'
    const { default: plugin } = await import(modulePath)
    const hook = vi.fn()
    const run = plugin as unknown as (nitro: {
      hooks: { hook: typeof hook }
    }) => void
    run({ hooks: { hook } })
    expect(hook).not.toHaveBeenCalled()
  } finally {
    if (saved !== undefined) process.env.OPEN3DFARM_CONFIGURATION = saved
    vi.doUnmock('nuxt/server')
    vi.unstubAllGlobals()
  }
})

it('retains challenge replay identities across adapter restart', async () => {
  const db = database()
  const store = new PostgresConfigurationStore(db.pool, config)
  const record = ConfigurationChallengeRecord.parse({
    pins: 'synthetic-pins',
    challenge: {
      v: 1,
      purpose: 'configuration-admission',
      protocol: 'config-v1',
      challenge_id: '66666666-6666-4666-8666-666666666666',
      capability_id: '77777777-7777-4777-8777-777777777777',
      farm_id: scope.farmId,
      agent_id: scope.agentId,
      key_id: scope.keyId,
      transport_id: '88888888-8888-4888-8888-888888888888',
      account_id: operation.account_id,
      browser_thumbprint: 'A'.repeat(43),
      origin: config.origin,
      audience: config.audience,
      configuration_binding_sha256: 'A'.repeat(43),
      admission_nonce: 'A'.repeat(43),
      action: 'prepare',
      operation_id: operation.operation_id,
      expected_revision: 0,
      target_sha256: 'A'.repeat(43),
      issued_at: 1000,
      expires_at: 2000,
    },
  })
  await store.transaction(scope, async (tx) => {
    expect(await tx.insertChallenge(record)).toBe(true)
    expect(await tx.consumeChallenge(record.challenge.challenge_id)).toEqual(
      record,
    )
  })
  const restarted = new PostgresConfigurationStore(db.pool, config)
  await restarted.transaction(scope, async (tx) => {
    expect(await tx.consumeChallenge(record.challenge.challenge_id)).toBeNull()
    expect(await tx.insertChallenge(record)).toBe(false)
  })
})
