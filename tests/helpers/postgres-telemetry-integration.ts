// Called only by the explicitly opted-in disposable PostgreSQL integration script.
import assert from 'node:assert/strict'
import type { Sql } from 'postgres'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PostgresTelemetryStore } from '../../apps/farm/server/storage/postgres-telemetry.ts'
import { ingestTelemetry } from '../../apps/farm/server/services/telemetry.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { drainTelemetryOnce } from '../../packages/connector/src/cloud/drain.ts'
import { parseMoonrakerSnapshot } from '../../packages/connector/src/moonraker/parse.ts'
const context = {
  farmId: '00000000-0000-4000-8000-000000000001',
  agentId: '00000000-0000-4000-8000-000000000002',
  printerKeys: new Set(['synthetic']),
}
const fixedEvent = {
  eventId: '00000000-0000-4000-8000-000000000004',
  queuedAt: 1000,
  kind: 'printer-state' as const,
  state: {
    printerKey: 'synthetic',
    state: 'printing' as const,
    progress: 0.5,
    observedAt: 1000,
  },
}
/**
 * The store also upserts farm.printer_latest_state (migration 0033) in the
 * same transaction. This fixture only carries 0001 and 0002, so it takes the
 * table definition verbatim from 0033; that migration's role grants need
 * later migrations and are out of scope for the dedup checks here.
 */
function latestStateTableSql(): string {
  const text = readFileSync(
    new URL(
      '../../infra/db/migrations/0033_printer_latest_state.up.sql',
      import.meta.url,
    ),
    'utf8',
  )
  const statement = text.slice(0, text.indexOf(';') + 1)
  assert.match(statement, /^CREATE TABLE farm\.printer_latest_state \(/)
  return statement
}
export async function testTelemetryPersistence(
  sql: Sql,
  afterRestart: boolean,
): Promise<string[]> {
  const store = new PostgresTelemetryStore(sql)
  const count = async () =>
    (await sql`SELECT count(*)::int AS count FROM farm.telemetry_events`)[0]
      ?.count
  if (afterRestart) {
    assert.equal(await count(), 3)
    assert.equal(
      (await ingestTelemetry(JSON.stringify([fixedEvent]), context, store)).ok,
      true,
    )
    assert.equal(await count(), 3)
    await sql.begin(async (tx) => {
      await tx`DROP TABLE farm.printer_latest_state`
      await tx
        .unsafe(
          readFileSync(
            new URL(
              '../../infra/db/migrations/0002_telemetry_events.down.sql',
              import.meta.url,
            ),
            'utf8',
          ),
        )
        .simple()
    })
    return ['telemetry-dedup-survives-database-restart']
  }
  await sql.begin(async (tx) => {
    await tx
      .unsafe(
        readFileSync(
          new URL(
            '../../infra/db/migrations/0002_telemetry_events.up.sql',
            import.meta.url,
          ),
          'utf8',
        ),
      )
      .simple()
    await tx.unsafe(latestStateTableSql()).simple()
  })
  // Fixture readiness: the store writes both tables in one transaction, so a
  // missing one would only surface later as an unexplained zero row count.
  for (const table of ['farm.telemetry_events', 'farm.printer_latest_state'])
    assert.ok(
      (await sql`SELECT to_regclass(${table}) AS t`)[0]?.t,
      `Telemetry fixture table ${table} must exist before ingestion`,
    )
  const directory = mkdtempSync(join(tmpdir(), 'open3d-postgres-queue-'))
  let queue = new TelemetryQueue(directory, 1000)
  try {
    const wire = readFileSync(
      new URL('../fixtures/moonraker/printing.json', import.meta.url),
      'utf8',
    )
    queue.enqueue(
      parseMoonrakerSnapshot(wire, {
        printerKey: 'synthetic',
        observedAt: 1000,
      }).printer,
      1000,
    )
    // The drain turns any sender throw into 'retained', so an assertion inside
    // the sender would be swallowed. Keep the ingestion result and check it here.
    let firstIngestion: Awaited<ReturnType<typeof ingestTelemetry>> | undefined
    const first = await drainTelemetryOnce(
      queue,
      async (body) => {
        firstIngestion = await ingestTelemetry(body, context, store)
        throw new Error('synthetic lost acknowledgement')
      },
      () => 1000,
      new AbortController().signal,
    )
    assert.deepEqual(first, {
      status: 'retained',
      reason: 'transport',
      loss: { expired: 0, capacity: 0, partialTail: false },
    })
    assert.equal(
      firstIngestion?.ok,
      true,
      `First ingestion must persist before the lost acknowledgement: ${JSON.stringify(firstIngestion)}`,
    )
    assert.equal(await count(), 1)
    queue.close()
    queue = new TelemetryQueue(directory, 1001)
    const second = await drainTelemetryOnce(
      queue,
      async (body) => {
        const result = await ingestTelemetry(body, context, store)
        assert.equal(result.ok, true)
        if (!result.ok) throw new Error('Fixture rejected')
        return result.acceptedEventIds
      },
      () => 1001,
      new AbortController().signal,
    )
    assert.equal(second.status, 'delivered')
    assert.equal(queue.depth, 0)
    assert.equal(await count(), 1)
  } finally {
    queue.close()
    rmSync(directory, { recursive: true, force: true })
  }
  const originalRow = (await sql`SELECT payload FROM farm.telemetry_events`)[0]
  assert.ok(originalRow)
  const original = originalRow.payload
  const conflict = await ingestTelemetry(
    JSON.stringify([
      fixedEvent,
      { ...original, queuedAt: original.queuedAt + 1 },
    ]),
    context,
    store,
  )
  assert.deepEqual(conflict, { ok: false, reason: 'conflict' })
  assert.equal(
    await count(),
    1,
    'Conflicting batch must roll back its new event too',
  )
  const concurrent = await Promise.all([
    store.commitBatch(context, [fixedEvent]),
    store.commitBatch(context, [fixedEvent]),
  ])
  assert.deepEqual(concurrent, ['committed', 'committed'])
  assert.equal(await count(), 2)
  assert.equal(
    await store.commitBatch({ ...context, farmId: fixedEvent.eventId }, [
      fixedEvent,
    ]),
    'committed',
  )
  assert.equal(await count(), 3)
  assert.deepEqual(
    await ingestTelemetry(JSON.stringify([fixedEvent]), null, store),
    { ok: false, reason: 'unauthorized' },
  )
  assert.equal(await count(), 3)
  return [
    'disk-queue-lost-ack-reopen-durable-dedup',
    'atomic-conflicting-batch-rollback',
    'concurrent-identical-insert-and-scope-isolation',
  ]
}
