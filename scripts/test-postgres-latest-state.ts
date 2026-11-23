import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import type { TelemetryEvent } from '@open3dfarmmanager/farm-protocol'
import { readLatestStateByAssignment } from '../apps/farm/server/storage/postgres-printer-latest-state.ts'
import { PostgresTelemetryStore } from '../apps/farm/server/storage/postgres-telemetry.ts'

const portText = process.env.LATEST_STATE_SYNTHETIC_TEST_PORT
const admitted = process.env.LATEST_STATE_TEST_DISPOSABLE
if (
  admitted !== 'yes' ||
  !portText ||
  !/^\d{4,5}$/.test(portText) ||
  Number(portText) < 1024 ||
  Number(portText) > 65535
)
  throw new Error('Explicit disposable loopback PostgreSQL fixture required')
const sql = postgres({
  host: '127.0.0.1',
  port: Number(portText),
  database: 'fixture',
  username: 'fixture',
  ssl: false,
  max: 1,
  connect_timeout: 3,
})
const farmId = randomUUID()
const agentId = randomUUID()
const assignmentId = randomUUID()
const make = (
  observedAt: number,
  state: 'printing' | 'paused' = 'printing',
  eventId: string = randomUUID(),
): TelemetryEvent => ({
  eventId,
  queuedAt: observedAt,
  kind: 'printer-state',
  state: { printerKey: 'test', state, progress: 0.5, observedAt },
})
try {
  await sql`SET session_replication_role = replica`
  await sql`INSERT INTO farm.printer_assignments (id,farm_id,agent_id,printer_key,created_at,created_by) VALUES (${assignmentId},${farmId},${agentId},'test',1,'fixture')`
  await sql`SET session_replication_role = origin`
  const store = new PostgresTelemetryStore(sql)
  const read = () => readLatestStateByAssignment(sql, { farmId, assignmentId })
  assert.equal(
    await store.commitBatch({ farmId, agentId }, [make(20), make(10)]),
    'committed',
  )
  assert.equal((await read())?.observedAt, 20)
  assert.equal(
    await store.commitBatch({ farmId, agentId }, [
      make(15),
      make(20, 'paused'),
    ]),
    'committed',
  )
  assert.equal((await read())?.state, 'printing')
  const original = make(25)
  assert.equal(
    await store.commitBatch({ farmId, agentId }, [original]),
    'committed',
  )
  assert.equal(
    await store.commitBatch({ farmId, agentId }, [
      make(40),
      make(30, 'paused', original.eventId),
    ]),
    'conflict',
  )
  assert.equal((await read())?.observedAt, 25)
  await sql`SET session_replication_role = replica`
  await sql`UPDATE farm.printer_assignments SET revoked_at=2, revoked_by='fixture' WHERE id=${assignmentId}`
  await sql`SET session_replication_role = origin`
  assert.equal(await read(), undefined)
} finally {
  await sql.end()
}
