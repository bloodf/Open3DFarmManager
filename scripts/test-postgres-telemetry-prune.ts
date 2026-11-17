import assert from 'node:assert/strict'
import postgres from 'postgres'
import {
  loadMigrationCatalog,
  validateMigrationHistory,
} from './db/migrations.ts'

const portText = process.env.TELEMETRY_PRUNE_SYNTHETIC_TEST_PORT
const port = Number(portText)
if (
  process.env.TELEMETRY_PRUNE_SYNTHETIC_TEST_DISPOSABLE !== 'yes' ||
  !portText ||
  !/^\d{4,5}$/.test(portText) ||
  port < 1024 ||
  port > 65535
)
  throw new Error('Explicit disposable loopback PostgreSQL fixture required')

const sql = postgres({
  host: '127.0.0.1',
  port,
  database: 'fixture',
  username: 'fixture',
  ssl: false,
  max: 4,
  connect_timeout: 3,
})
try {
  const identity = (
    await sql`SELECT current_database() AS database, current_user AS username`
  )[0]
  assert.deepEqual(identity, { database: 'fixture', username: 'fixture' })
  const catalog = await loadMigrationCatalog()
  const journal =
    await sql`SELECT position,id,checksum FROM public.open3dfarm_migrations ORDER BY position`
  assert.equal(validateMigrationHistory(catalog, [...journal]), catalog.length)
  assert.equal(
    catalog.find((entry) => entry.id === '0036_telemetry_prune')?.id,
    '0036_telemetry_prune',
  )
  const privileges = await sql`
    SELECT has_table_privilege('farm_telemetry_prune_owner','farm.telemetry_events','SELECT') AS event_select,
           has_table_privilege('farm_telemetry_prune_owner','farm.telemetry_events','DELETE') AS event_delete,
           has_table_privilege('farm_telemetry_prune_owner','farm.job_history','SELECT') AS job_select,
           has_table_privilege('farm_telemetry_prune_owner','farm.job_history','DELETE') AS job_delete,
           pg_get_userbyid(p.proowner) AS function_owner, p.prosecdef AS security_definer
    FROM pg_proc p WHERE p.oid='farm.prune_telemetry(integer,integer,integer)'::regprocedure`
  assert.deepEqual(privileges[0], {
    event_select: true,
    event_delete: true,
    job_select: true,
    job_delete: true,
    function_owner: 'farm_telemetry_prune_owner',
    security_definer: true,
  })

  const farmId = '11111111-1111-4111-8111-111111111111'
  const agentId = '22222222-2222-4222-8222-222222222222'
  const now = Date.now()
  const oldEventId = '33333333-3333-4333-8333-333333333331'
  const newEventId = '33333333-3333-4333-8333-333333333332'
  const latestKey = 'telemetry-prune-sentinel'
  await sql`INSERT INTO farm.farms(id) VALUES (${farmId}::uuid) ON CONFLICT DO NOTHING`
  await sql`INSERT INTO farm.telemetry_events(farm_id,agent_id,event_id,payload) VALUES
    (${farmId}::uuid,${agentId}::uuid,${oldEventId}::uuid,jsonb_build_object('queuedAt',${now - 31 * 86400000}::bigint)),
    (${farmId}::uuid,${agentId}::uuid,'33333333-3333-4333-8333-333333333333'::uuid,jsonb_build_object('queuedAt',${now - 32 * 86400000}::bigint)),
    (${farmId}::uuid,${agentId}::uuid,'33333333-3333-4333-8333-333333333334'::uuid,jsonb_build_object('queuedAt',${now - 33 * 86400000}::bigint)),
    (${farmId}::uuid,${agentId}::uuid,'33333333-3333-4333-8333-333333333335'::uuid,jsonb_build_object('queuedAt',${now - 34 * 86400000}::bigint)),
    (${farmId}::uuid,${agentId}::uuid,${newEventId}::uuid,jsonb_build_object('queuedAt',${now}::bigint))`
  await sql`INSERT INTO farm.job_history(farm_id,agent_id,printer_key,outcome,ended_at) VALUES
    (${farmId}::uuid,${agentId}::uuid,'prune-old-1','completed',${now - 400 * 86400000}),
    (${farmId}::uuid,${agentId}::uuid,'prune-old-2','completed',${now - 401 * 86400000}),
    (${farmId}::uuid,${agentId}::uuid,'prune-old-3','completed',${now - 402 * 86400000}),
    (${farmId}::uuid,${agentId}::uuid,'prune-new','completed',${now})`
  await sql`INSERT INTO farm.printer_latest_state(farm_id,agent_id,printer_key,observed_at,state)
    VALUES (${farmId}::uuid,${agentId}::uuid,${latestKey},${now - 900 * 86400000},'{}'::jsonb)
    ON CONFLICT (farm_id,agent_id,printer_key) DO UPDATE SET observed_at=excluded.observed_at,state=excluded.state`

  await assert.rejects(
    sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE farm_telemetry_pruner`
      await tx`DELETE FROM farm.telemetry_events WHERE event_id=${oldEventId}::uuid`
    }),
  )

  const runPrune = async () =>
    sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE farm_telemetry_pruner`
      await tx`SET LOCAL statement_timeout='5000ms'`
      const [result] = await tx`SELECT * FROM farm.prune_telemetry(30,365,2)`
      assert.equal(
        await tx`SELECT current_setting('statement_timeout') AS timeout`.then(
          (rows) => rows[0]?.timeout,
        ),
        '5s',
      )
      return result
    })
  const first = await runPrune()
  assert.equal(first?.telemetry_deleted, 2)
  assert.equal(first?.jobs_deleted, 2)
  const remaining = await sql`
    SELECT (SELECT count(*)::int FROM farm.telemetry_events WHERE farm_id=${farmId}::uuid) AS events,
           (SELECT count(*)::int FROM farm.job_history WHERE farm_id=${farmId}::uuid) AS jobs,
           (SELECT count(*)::int FROM farm.printer_latest_state WHERE farm_id=${farmId}::uuid AND printer_key=${latestKey}) AS latest`
  assert.deepEqual(remaining[0], { events: 3, jobs: 2, latest: 1 })
  const second = await runPrune()
  assert.equal(second?.telemetry_deleted, 2)
  assert.equal(second?.jobs_deleted, 1)
  const final =
    await sql`SELECT count(*)::int AS count FROM farm.telemetry_events WHERE farm_id=${farmId}::uuid AND event_id=${newEventId}::uuid`
  assert.equal(final[0]?.count, 1)
} finally {
  await sql.end({ timeout: 3 })
}
