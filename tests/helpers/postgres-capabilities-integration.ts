// Disposable DB only: login roles below are synthetic test fixtures, never deployment accounts.
import assert from 'node:assert/strict'
import postgres, { type Sql } from 'postgres'
import { readFileSync } from 'node:fs'
import { generateKeyPairSync } from 'node:crypto'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import { EnrolledConnectorProof } from '../../apps/farm/server/services/enrolled-connector-proof.ts'
import { PostgresEnrollmentSource } from '../../apps/farm/server/storage/postgres-enrollment.ts'
import { PostgresTelemetryStore } from '../../apps/farm/server/storage/postgres-telemetry.ts'
const scope = {
  farmId: '00000000-0000-4000-8000-000000000001',
  agentId: '00000000-0000-4000-8000-000000000010',
}
const connection = '00000000-0000-4000-8000-000000000011'
const event = {
  eventId: connection,
  queuedAt: 1000,
  kind: 'printer-state' as const,
  state: {
    printerKey: 'synthetic',
    state: 'printing' as const,
    progress: 0.5,
    observedAt: 1000,
  },
}
const denied = (query: PromiseLike<unknown>, code = '42501') =>
  assert.rejects(
    async () => {
      await query
    },
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === code,
  )
export async function testDatabaseCapabilities(
  admin: Sql,
  port: number,
  afterRestart: boolean,
): Promise<string[]> {
  const migration = (direction: string) =>
    readFileSync(
      new URL(
        `../../infra/db/migrations/0003_runtime_capabilities.${direction}.sql`,
        import.meta.url,
      ),
      'utf8',
    )
  if (!afterRestart) {
    await admin.begin(async (tx) => {
      await tx.unsafe(migration('up')).simple()
    })
    await admin`CREATE ROLE fixture_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
    await admin`CREATE ROLE fixture_writer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
    await admin`GRANT farm_enrollment_reader TO fixture_reader`
    await admin`GRANT farm_telemetry_writer TO fixture_writer`
  }
  const reader = postgres({
    hostname: '127.0.0.1',
    port,
    username: 'fixture_reader',
    database: 'fixture',
    max: 2,
    connect_timeout: 3,
  })
  const writer = postgres({
    hostname: '127.0.0.1',
    port,
    username: 'fixture_writer',
    database: 'fixture',
    max: 2,
    connect_timeout: 3,
  })
  try {
    for (const pool of [reader, writer]) {
      const [role] =
        await pool`SELECT rolsuper, rolcreaterole, rolcreatedb, rolbypassrls FROM pg_roles WHERE rolname = current_user`
      assert.ok(role)
      assert.deepEqual(
        [
          role.rolsuper,
          role.rolcreaterole,
          role.rolcreatedb,
          role.rolbypassrls,
        ],
        [false, false, false, false],
      )
      await denied(pool`CREATE TABLE farm.forbidden (id int)`)
      await denied(pool`SET ROLE fixture`)
    }
    const proof = new EnrolledConnectorProof(
      new PostgresEnrollmentSource(reader),
    )
    const store = new PostgresTelemetryStore(writer)
    if (!afterRestart) {
      const identity = new ConnectorIdentity(
        generateKeyPairSync('ed25519').privateKey,
      )
      await admin`INSERT INTO farm.connector_enrollments (farm_id,agent_id,public_key_spki,fingerprint) VALUES (${scope.farmId}::uuid,${scope.agentId}::uuid,${identity.publicKeySpki},${identity.fingerprint})`
      assert.equal(await proof.issue(scope, connection, () => 1000, 5000), null)
      await denied(
        reader`UPDATE farm.connector_enrollments SET status = 'approved' WHERE agent_id = ${scope.agentId}::uuid`,
      )
      await admin`UPDATE farm.connector_enrollments SET status = 'approved' WHERE agent_id = ${scope.agentId}::uuid`
      const challenge = await proof.issue(scope, connection, () => 1000, 5000)
      assert.ok(challenge)
      assert.equal(
        await proof.complete(
          scope,
          connection,
          challenge.nonce,
          identity.signProof(Buffer.from(challenge.nonce, 'base64url')),
          () => 1001,
        ),
        true,
      )
      await admin`UPDATE farm.connector_enrollments SET status = 'revoked' WHERE agent_id = ${scope.agentId}::uuid`
    }
    assert.equal(await proof.issue(scope, connection, () => 1001, 5000), null)
    await denied(
      reader`UPDATE farm.connector_enrollments SET agent_id = ${connection}::uuid WHERE agent_id = ${scope.agentId}::uuid`,
      'P0001',
    )
    await denied(reader`DELETE FROM farm.connector_enrollments`)
    await denied(reader`TRUNCATE farm.connector_enrollments`)
    await denied(
      reader`ALTER TABLE farm.connector_enrollments DISABLE TRIGGER ALL`,
    )
    await denied(reader`SELECT * FROM farm.telemetry_events`)
    await denied(writer`SELECT * FROM farm.connector_enrollments`)
    assert.equal(await store.commitBatch(scope, [event]), 'committed')
    assert.equal(await store.commitBatch(scope, [event]), 'committed')
    assert.equal(
      await store.commitBatch(scope, [{ ...event, queuedAt: 1001 }]),
      'conflict',
    )
    await denied(
      writer`UPDATE farm.telemetry_events SET event_id = event_id WHERE event_id = ${connection}::uuid`,
      'P0001',
    )
    await denied(writer`UPDATE farm.telemetry_events SET payload = '{}'::jsonb`)
    await denied(writer`DELETE FROM farm.telemetry_events`)
    await denied(writer`TRUNCATE farm.telemetry_events`)
    await denied(writer`ALTER TABLE farm.telemetry_events DISABLE TRIGGER ALL`)
    const [stored] =
      await admin`SELECT payload FROM farm.telemetry_events WHERE event_id = ${connection}::uuid`
    assert.ok(stored)
    assert.deepEqual(stored.payload, event)
    // Owner-only fixture cleanup keeps the existing telemetry fixture's row-count invariant.
    await admin`DELETE FROM farm.telemetry_events WHERE event_id = ${connection}::uuid`
  } finally {
    await reader.end()
    await writer.end()
  }
  if (afterRestart) {
    await admin.begin(async (tx) => {
      await tx.unsafe(migration('down')).simple()
    })
    await admin`DROP ROLE fixture_reader`
    await admin`DROP ROLE fixture_writer`
  }
  return [
    afterRestart
      ? 'least-privilege-capabilities-survive-restart-and-roll-back'
      : 'restricted-role-proof-and-telemetry-work-with-write-ddl-escalation-denials',
  ]
}
