import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import type { Sql, TransactionSql } from 'postgres'
import {
  recordLatestStates,
  readLatestStateByAssignment,
} from '../../apps/farm/server/storage/postgres-printer-latest-state.ts'
import type { TelemetryEvent } from '@open3dfarmmanager/farm-protocol'

const scope = {
  farmId: '00000000-0000-4000-8000-000000000001',
  agentId: '00000000-0000-4000-8000-000000000002',
}
const event = (
  id: string,
  printerKey: string,
  observedAt: number,
): TelemetryEvent => ({
  eventId: id,
  queuedAt: observedAt,
  kind: 'printer-state',
  state: { printerKey, observedAt, state: 'printing', progress: 0.5 },
})

test('writes snapshots in stable printer order and ignores transitions', async () => {
  const writes: unknown[][] = []
  const tx = Object.assign(
    async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      writes.push(values)
      return []
    },
    { json: (value: unknown) => value },
  ) as unknown as TransactionSql
  await recordLatestStates(tx, scope, [
    event('1', 'z', 20),
    {
      eventId: '2',
      queuedAt: 10,
      kind: 'printer-transition',
      transition: {
        printerKey: 'a',
        from: 'idle',
        to: 'printing',
        observedAt: 10,
      },
    },
    event('3', 'a', 30),
  ])
  assert.deepEqual(
    writes.map((values) => values[2]),
    ['a', 'z'],
  )
  assert.deepEqual(
    writes.map((values) => values[3]),
    [30, 20],
  )
})

test('assignment reads use farm scope and exclude revocations', async () => {
  let query = ''
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    query = strings.join('?')
    assert.deepEqual(values, [scope.farmId, 'assignment'])
    return []
  }) as unknown as Sql
  assert.equal(
    await readLatestStateByAssignment(sql, {
      farmId: scope.farmId,
      assignmentId: 'assignment',
    }),
    undefined,
  )
  assert.match(query, /a\.revoked_at IS NULL/)
  assert.match(
    query,
    /s\.farm_id = a\.farm_id AND s\.agent_id = a\.agent_id AND s\.printer_key = a\.printer_key/,
  )
})

test('migration uses a strict timestamp comparison and has a down migration', async () => {
  const source = await readFile(
    new URL(
      '../../apps/farm/server/storage/postgres-printer-latest-state.ts',
      import.meta.url,
    ),
    'utf8',
  )
  const down = await readFile(
    new URL(
      '../../infra/db/migrations/0033_printer_latest_state.down.sql',
      import.meta.url,
    ),
    'utf8',
  )
  assert.match(
    source,
    /printer_latest_state\.observed_at < EXCLUDED\.observed_at/,
  )
  assert.match(down, /DROP TABLE farm\.printer_latest_state/)
})

if (process.env.LATEST_STATE_TEST_URL) {
  test('PostgreSQL preserves newer states and hides revoked assignments', async () => {
    const { default: postgres } = await import('postgres')
    const { randomUUID } = await import('node:crypto')
    const { PostgresTelemetryStore } =
      await import('../../apps/farm/server/storage/postgres-telemetry.ts')
    const sql = postgres(process.env.LATEST_STATE_TEST_URL!, { max: 1 })
    const farmId = randomUUID(),
      agentId = randomUUID(),
      assignmentId = randomUUID()
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
      const read = () =>
        readLatestStateByAssignment(sql, { farmId, assignmentId })
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
  })
}
