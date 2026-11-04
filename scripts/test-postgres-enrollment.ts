// Opt-in destructive integration fixture: dedicated disposable PostgreSQL only.
import assert from 'node:assert/strict'
import { SQL } from 'bun'
import { readFile } from 'node:fs/promises'
import { generateKeyPairSync } from 'node:crypto'
import { ConnectorIdentity } from '../packages/connector/src/identity/store.ts'
import { EnrolledConnectorProof } from '../apps/farm/server/services/enrolled-connector-proof.ts'
import { PostgresEnrollmentSource } from '../apps/farm/server/storage/postgres-enrollment.ts'
const port = Number(process.env.ENROLLMENT_SYNTHETIC_TEST_PORT)
if (
  process.env.ENROLLMENT_SYNTHETIC_TEST_DISPOSABLE !== 'yes' ||
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535
)
  throw new Error('Explicit disposable PostgreSQL port required')
const sql = new SQL({
  hostname: '127.0.0.1',
  port,
  username: 'fixture',
  database: 'fixture',
  max: 4,
  connectionTimeout: 3,
})
const scope = {
  farmId: '00000000-0000-4000-8000-000000000001',
  agentId: '00000000-0000-4000-8000-000000000002',
}
const connection = '00000000-0000-4000-8000-000000000003'
const source = new PostgresEnrollmentSource(sql)
const proof = new EnrolledConnectorProof(source)
const checks: string[] = []
const up = await readFile(
  new URL(
    '../infra/db/migrations/0001_connector_enrollments.up.sql',
    import.meta.url,
  ),
  'utf8',
)
const down = await readFile(
  new URL(
    '../infra/db/migrations/0001_connector_enrollments.down.sql',
    import.meta.url,
  ),
  'utf8',
)
try {
  if (process.argv.includes('--after-restart')) {
    let status: string | undefined
    await source.withEnrollment(scope, (record) => {
      status = record?.status
    })
    assert.equal(status, 'revoked')
    assert.equal(await proof.issue(scope, connection, () => 1000, 5000), null)
    checks.push('revocation-survives-database-restart')
    await sql.begin(async (tx) => {
      await tx.unsafe(down).simple()
    })
    assert.equal(await proof.issue(scope, connection, () => 1000, 5000), null)
    await sql.begin(async (tx) => {
      await tx.unsafe(up).simple()
    })
    assert.equal(
      (
        await sql`SELECT count(*)::int AS count FROM farm.connector_enrollments`
      )[0].count,
      0,
    )
    checks.push('explicit-down-up-and-missing-table-fail-closed')
  } else {
    assert.equal(
      (
        await sql`SELECT count(*)::int AS count FROM pg_namespace WHERE nspname = 'farm'`
      )[0].count,
      0,
      'Requires fresh dedicated database',
    )
    await sql.begin(async (tx) => {
      await tx.unsafe(up).simple()
    })
    const identity = new ConnectorIdentity(
      generateKeyPairSync('ed25519').privateKey,
    )
    assert.equal(await proof.issue(scope, connection, () => 1000, 5000), null)
    await sql`INSERT INTO farm.connector_enrollments (farm_id,agent_id,public_key_spki,fingerprint) VALUES (${scope.farmId}::uuid,${scope.agentId}::uuid,${identity.publicKeySpki},${identity.fingerprint})`
    assert.equal(await proof.issue(scope, connection, () => 1000, 5000), null)
    await sql`UPDATE farm.connector_enrollments SET status = 'approved' WHERE agent_id = ${scope.agentId}::uuid`
    const challenge = await proof.issue(scope, connection, () => 1000, 5000)
    assert.ok(challenge)
    const signature = identity.signProof(
      Buffer.from(challenge.nonce, 'base64url'),
    )
    assert.equal(
      await proof.complete(
        scope,
        connection,
        challenge.nonce,
        signature,
        () => 1001,
      ),
      true,
    )
    assert.equal(
      await proof.complete(
        scope,
        connection,
        challenge.nonce,
        signature,
        () => 1001,
      ),
      false,
    )
    assert.equal(
      await proof.issue(
        { ...scope, farmId: connection },
        connection,
        () => 1001,
        5000,
      ),
      null,
    )
    checks.push('missing-pending-approved-signature-replay-and-wrong-farm')
    await assert.rejects(
      source.withEnrollment({ ...scope, agentId: "' OR TRUE --" }, () =>
        assert.fail('Injection reached callback'),
      ),
      /^Error: Enrollment storage unavailable$/,
    )
    checks.push('parameterized-input-redaction')
    await assert.rejects(
      sql.begin(async (tx) => {
        await tx`UPDATE farm.connector_enrollments SET status = 'revoked' WHERE agent_id = ${scope.agentId}::uuid`
        throw new Error('synthetic rollback')
      }),
      /synthetic rollback/,
    )
    assert.ok(await proof.issue(scope, connection, () => 1001, 5000))
    checks.push('rolled-back-revocation-does-not-change-committed-state')
    // Hold a real row writer, prove the reader waits on its lock, then commit revocation.
    const pending = await proof.issue(scope, connection, () => 1001, 5000)
    assert.ok(pending)
    let release!: () => void
    let locked!: () => void
    const held = new Promise<void>((resolve) => {
      locked = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const writer = sql.begin(async (tx) => {
      await tx`UPDATE farm.connector_enrollments SET status = 'revoked' WHERE agent_id = ${scope.agentId}::uuid`
      locked()
      await gate
    })
    await held
    let completed = false
    const completion = proof
      .complete(
        scope,
        connection,
        pending.nonce,
        identity.signProof(Buffer.from(pending.nonce, 'base64url')),
        () => 1002,
      )
      .then((value) => {
        completed = true
        return value
      })
    try {
      const start = performance.now()
      while (true) {
        const waiting =
          await sql`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = 'fixture' AND wait_event_type = 'Lock' AND query LIKE '%FROM farm.connector_enrollments%'`
        if (waiting[0].count > 0) break
        assert.ok(
          performance.now() - start < 800,
          'Reader must enter row lock wait',
        )
        await Bun.sleep(5)
      }
      assert.equal(completed, false)
    } finally {
      release()
      await writer
    }
    assert.equal(await completion, false)
    checks.push('concurrent-proof-waits-for-revocation-commit-and-denies')
    await assert.rejects(
      sql`UPDATE farm.connector_enrollments SET status = 'approved' WHERE agent_id = ${scope.agentId}::uuid`,
    )
    await assert.rejects(
      sql`DELETE FROM farm.connector_enrollments WHERE agent_id = ${scope.agentId}::uuid`,
    )
    await assert.rejects(
      sql`UPDATE farm.connector_enrollments SET farm_id = ${connection}::uuid WHERE agent_id = ${scope.agentId}::uuid`,
    )
    await assert.rejects(
      sql`INSERT INTO farm.connector_enrollments (farm_id,agent_id,status,public_key_spki,fingerprint) VALUES (${scope.farmId}::uuid,${connection}::uuid,'approved',${identity.publicKeySpki},${identity.fingerprint})`,
    )
    await assert.rejects(sql`TRUNCATE farm.connector_enrollments`)
    checks.push(
      'terminal-revocation-tombstone-immutable-binding-and-pending-insert',
    )
  }
} finally {
  await sql.close()
}
assert.equal(await proof.issue(scope, connection, () => 1002, 5000), null)
checks.push('closed-storage-fails-closed')
console.log(JSON.stringify({ result: 'passed', checks }))
