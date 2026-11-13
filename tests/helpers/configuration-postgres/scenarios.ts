import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'
import { PostgresConfigurationStore } from '../../../apps/farm/server/storage/postgres-configuration.ts'
import { PostgresPairing } from '../../../apps/farm/server/storage/postgres-pairing.ts'
import { PostgresPairingProof } from '../../../apps/farm/server/storage/postgres-pairing-proof.ts'
import { ConnectorIdentity } from '../../../packages/connector/src/identity/store.ts'
import { validateBrowserDevicePublicKey } from '../../../packages/farm-protocol/src/browser-device-proof.ts'
import { deriveConfigurationAssignmentIdentity } from '../../../packages/farm-protocol/src/configuration-inventory.ts'

/** Caller must supply a fresh disposable cluster with the complete real migration catalog. */
export async function qualifyConfiguration(
  admin: Sql,
  connect: (role: string) => Sql,
  record: (event: object) => Promise<unknown>,
) {
  const config = {
    origin: 'https://configuration.example',
    audience: 'farm',
    credentialIssuer: 'fixture',
    credentialAudience: 'connector',
    idleTimeoutMs: 1800000,
  }
  const role = 'configuration_' + randomUUID().replaceAll('-', '')
  await admin`CREATE ROLE ${admin(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_configuration_authority`
  let sql = connect(role)
  const state = (code: string) => (e: unknown) =>
    typeof e === 'object' && e !== null && 'code' in e && e.code === code
  assert.equal((await sql`SELECT current_user AS role`)[0]?.role, role)
  await assert.rejects(
    sql`DELETE FROM farm.configuration_receipts`,
    state('42501'),
  )
  await assert.rejects(
    sql`UPDATE farm.memberships SET role='owner'`,
    state('42501'),
  )
  await assert.rejects(
    sql`INSERT INTO farm.session_accounts(id) VALUES ('forbidden')`,
    state('42501'),
  )
  await record({ qualification: 'migrations_and_grants', status: 'pass' })
  const now = Number(
    (
      await admin`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::float8 AS now`
    )[0]?.now,
  )
  const account = 'fixture_' + randomUUID(),
    farm = randomUUID(),
    keyId = randomUUID()
  await admin`INSERT INTO farm.session_accounts(id) VALUES (${account})`
  await admin`INSERT INTO farm.account_sessions(id,account_id,account_version,created_at,last_seen_at,absolute_expires_at) VALUES (${account},${account},0,${now},${now},${now + 1800000})`
  await admin`INSERT INTO farm.farms(id) VALUES (${farm}::uuid)`
  await admin`INSERT INTO farm.memberships(farm_id,account_id,role) VALUES (${farm}::uuid,${account},'owner')`
  const identity = new ConnectorIdentity(
    generateKeyPairSync('ed25519').privateKey,
  )
  const pairingConfig = {
    origin: config.origin,
    audience: 'open3dfarmmanager:pairing',
  }
  const pairing = new PostgresPairing(admin, pairingConfig)
  const proof = new PostgresPairingProof(admin, pairingConfig)
  const started = await pairing.start({
    public_key_spki: identity.publicKeySpki,
    platform: 'linux',
    version: '0.0.1',
  })
  assert.ok(started.ok)
  const challenge = await proof.issue({
    device_code: started.response.device_code,
  })
  assert.ok(challenge.ok)
  assert.ok(
    (
      await proof.complete({
        device_code: started.response.device_code,
        challenge: challenge.challenge,
        signature: identity.signPairingProof({
          challenge: challenge.challenge,
          expectedOrigin: config.origin,
          expectedAudience: pairingConfig.audience,
          now: Date.now(),
        }),
      })
    ).ok,
  )
  assert.ok(
    (
      await pairing.decide({
        sessionRecordId: account,
        policy: { idleTimeoutMs: 1800000 },
        decision: 'approve',
        request: {
          user_code: started.response.user_code,
          farm_id: farm,
          expected_fingerprint: identity.fingerprint,
        },
      })
    ).ok,
  )
  const issuer = await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])
  const claimed = await pairing.claim(
    { device_code: started.response.device_code },
    {
      issuer: config.credentialIssuer,
      audience: config.credentialAudience,
      kid: 'fixture',
      privateKey: issuer.privateKey,
      ttlSeconds: 3600,
    },
  )
  assert.ok(claimed.ok && claimed.status === 'approved')
  const agent = claimed.agent_id
  const browser = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )
  const jwk = await crypto.subtle.exportKey('jwk', browser.publicKey)
  const key = await validateBrowserDevicePublicKey({
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
  })
  await admin`INSERT INTO farm.browser_device_keys(key_id,farm_id,account_id,public_key,thumbprint,created_at) VALUES (${keyId}::uuid,${farm}::uuid,${account},${admin.json(key.publicKey)}::jsonb,${key.thumbprint},${now})`
  await admin`UPDATE farm.browser_device_keys SET status='approved',proof_at=${now},proof_session_id=${account},approved_at=${now},approved_by=${account} WHERE key_id=${keyId}::uuid`
  const scope = {
    sessionRecordId: account,
    farmId: farm,
    agentId: agent,
    keyId,
  }
  let store = new PostgresConfigurationStore(sql, config)
  assert.equal((await store.read(scope))?.authority.role, 'owner')
  await admin`UPDATE farm.memberships SET role='admin' WHERE farm_id=${farm}::uuid AND account_id=${account}`
  assert.equal((await store.read(scope))?.authority.role, 'admin')
  await admin`UPDATE farm.memberships SET role='viewer' WHERE farm_id=${farm}::uuid AND account_id=${account}`
  assert.equal(await store.read(scope), null)
  await admin`UPDATE farm.memberships SET role='owner' WHERE farm_id=${farm}::uuid AND account_id=${account}`
  const foreign = 'foreign_' + randomUUID()
  await admin`INSERT INTO farm.session_accounts(id) VALUES (${foreign})`
  await admin`INSERT INTO farm.account_sessions(id,account_id,account_version,created_at,last_seen_at,absolute_expires_at) VALUES (${foreign},${foreign},0,${now},${now},${now + 1800000})`
  assert.equal(await store.read({ ...scope, sessionRecordId: foreign }), null)
  const operation = (id: string) => ({
    operation_id: id,
    account_id: account,
    farm_id: farm,
    agent_id: agent,
    key_id: keyId,
    expected_revision: 0,
    target_sha256: 'A'.repeat(43),
    commit_sha256: 'A'.repeat(43),
    created_at: now,
  })
  const receipt = async (device: string) => ({
    operation_id: randomUUID(),
    receipt_sha256: 'A'.repeat(43),
    receipt_wire: 'synthetic-signed-receipt',
    account_id: account,
    farm_id: farm,
    agent_id: agent,
    bridge_instance_id: 'synthetic-bridge',
    device_id: device,
    ...(await deriveConfigurationAssignmentIdentity({
      account_id: account,
      farm_id: farm,
      agent_id: agent,
      bridge_instance_id: 'synthetic-bridge',
      device_id: device,
    })),
    committed_revision: 1,
    registered_at: now,
  })
  const snapshot = async () => ({
    assignments: [
      ...(await admin`SELECT * FROM farm.printer_assignments ORDER BY id`),
    ],
    receipts: [
      ...(await admin`SELECT * FROM farm.configuration_receipts ORDER BY operation_id`),
    ],
  })
  const first = await receipt('printer-one')
  await store.transaction(scope, async (tx) => {
    assert.ok(await tx.createOperation(operation(first.operation_id)))
  })
  await record({
    stage: 'operation-persistence',
    rows: [
      ...(await admin`SELECT operation_id, jsonb_typeof(record) AS record_type, record FROM farm.configuration_operations WHERE operation_id=${first.operation_id}::uuid`),
    ],
    before: await snapshot(),
  })
  try {
    assert.deepEqual(
      await store.transaction(scope, (tx) => tx.registerReceipt(first)),
      {
        ok: true,
        assignmentId: first.assignment_id,
      },
    )
  } catch (error) {
    await record({ stage: 'registration-failure', after: await snapshot() })
    throw error
  }
  const registered = await snapshot()
  assert.equal(registered.assignments.length, 1)
  assert.equal(registered.receipts.length, 1)
  await record({
    qualification: 'atomic_registration',
    status: 'pass',
    rows: registered,
  })
  await sql.end({ timeout: 3 })
  sql = connect(role)
  store = new PostgresConfigurationStore(sql, config)
  assert.deepEqual(
    await store.transaction(scope, (tx) => tx.registerReceipt(first)),
    { ok: true, assignmentId: first.assignment_id },
  )
  assert.deepEqual(await snapshot(), registered)
  await record({
    qualification: 'replay_after_reconnect',
    status: 'pass',
    rows: await snapshot(),
  })
  for (const change of [
    { assignment_id: randomUUID() },
    { device_id: 'changed' },
    { receipt_wire: 'different' },
    { account_id: foreign },
  ]) {
    assert.deepEqual(
      await store.transaction(scope, (tx) =>
        tx.registerReceipt({ ...first, ...change }),
      ),
      { ok: false },
    )
    assert.deepEqual(await snapshot(), registered)
  }
  const occupied = await receipt('occupied')
  await admin`INSERT INTO farm.printer_assignments(id,farm_id,agent_id,printer_key,created_at,created_by) VALUES (${occupied.assignment_id}::uuid,${farm}::uuid,${agent}::uuid,${occupied.printer_key},${now},${account})`
  await admin`INSERT INTO farm.printer_assignments(id,farm_id,agent_id,printer_key,created_at,created_by) VALUES (${randomUUID()}::uuid,${farm}::uuid,${agent}::uuid,'moonraker-existing',${now},${account})`
  const beforeConflict = await snapshot()
  await store.transaction(scope, async (tx) => {
    assert.ok(await tx.createOperation(operation(occupied.operation_id)))
    assert.deepEqual(await tx.registerReceipt(occupied), { ok: false })
  })
  assert.deepEqual(await snapshot(), beforeConflict)
  await record({
    qualification: 'conflict_isolation',
    status: 'pass',
    rows: beforeConflict,
  })
  const rolled = await receipt('rollback')
  await assert.rejects(
    store.transaction(scope, async (tx) => {
      await tx.createOperation(operation(rolled.operation_id))
      assert.ok((await tx.registerReceipt(rolled)).ok)
      throw new Error('intentional-rollback')
    }),
    /intentional-rollback/,
  )
  assert.deepEqual(await snapshot(), beforeConflict)
  assert.equal(
    (
      await admin`SELECT * FROM farm.configuration_operations WHERE operation_id=${rolled.operation_id}::uuid`
    ).length,
    0,
  )
  await record({
    qualification: 'rollback',
    status: 'pass',
    rows: await snapshot(),
  })
  const raced = await receipt('concurrent')
  const raced2 = {
    ...raced,
    operation_id: randomUUID(),
    receipt_wire: 'another-receipt',
  }
  for (const r of [raced, raced2])
    await store.transaction(scope, (tx) =>
      tx.createOperation(operation(r.operation_id)),
    )
  const outcomes = await Promise.allSettled(
    [raced, raced2].map((r) =>
      store.transaction(scope, (tx) => tx.registerReceipt(r)),
    ),
  )
  assert.equal(
    outcomes.filter((o) => o.status === 'fulfilled' && o.value.ok).length,
    1,
  )
  for (const outcome of outcomes)
    if (outcome.status === 'rejected')
      assert.ok(state('40001')(outcome.reason), String(outcome.reason))
  assert.equal(
    (
      await admin`SELECT * FROM farm.printer_assignments WHERE id=${raced.assignment_id}::uuid`
    ).length,
    1,
  )
  assert.equal(
    (
      await admin`SELECT * FROM farm.configuration_receipts WHERE assignment_id=${raced.assignment_id}::uuid`
    ).length,
    1,
  )
  await record({
    qualification: 'concurrency',
    status: 'pass',
    outcomes,
    rows: await snapshot(),
  })
  const beforeRevocation = await snapshot()
  await admin`UPDATE farm.browser_device_keys SET status='revoked',revoked_at=${Date.now()},revoked_by=${account} WHERE key_id=${keyId}::uuid`
  assert.equal(await store.read(scope), null)
  assert.deepEqual(
    await store.transaction(scope, (tx) => tx.registerReceipt(first)),
    { ok: false },
  )
  assert.deepEqual(await snapshot(), beforeRevocation)
  // A distinct still-approved key isolates credential revocation from browser revocation.
  const secondKey = randomUUID()
  const browser2 = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )
  const jwk2 = await crypto.subtle.exportKey('jwk', browser2.publicKey)
  const key2 = await validateBrowserDevicePublicKey({
    kty: jwk2.kty,
    crv: jwk2.crv,
    x: jwk2.x,
    y: jwk2.y,
  })
  await admin`INSERT INTO farm.browser_device_keys(key_id,farm_id,account_id,public_key,thumbprint,created_at) VALUES (${secondKey}::uuid,${farm}::uuid,${account},${admin.json(key2.publicKey)}::jsonb,${key2.thumbprint},${now})`
  await admin`UPDATE farm.browser_device_keys SET status='approved',proof_at=${now},proof_session_id=${account},approved_at=${now},approved_by=${account} WHERE key_id=${secondKey}::uuid`
  const secondScope = { ...scope, keyId: secondKey }
  assert.ok(await store.read(secondScope))
  await admin`UPDATE farm.connector_enrollments SET status='revoked' WHERE agent_id=${agent}::uuid`
  await admin`INSERT INTO farm.connector_revocations(agent_id,farm_id,fingerprint,credential_jti,revoked_at,revoked_by) SELECT agent_id,farm_id,fingerprint,jti,${Date.now()},${account} FROM farm.connector_credentials WHERE agent_id=${agent}::uuid`
  assert.equal(await store.read(secondScope), null)
  assert.deepEqual(await snapshot(), beforeRevocation)
  await record({
    qualification: 'current_authority',
    status: 'pass',
    rows: await snapshot(),
  })
}
