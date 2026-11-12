// Explicit disposable loopback fixture only. Caller owns all synthetic rows and cluster teardown.
import assert from 'node:assert/strict'
import { isAbsolute, relative } from 'node:path'
import postgres from 'postgres'
import {
  catalogThrough,
  loadMigrationCatalog,
  runMigrations,
  validateMigrationHistory,
} from './db/migrations.ts'
import { testPostgresAtomicTelemetry } from '../tests/helpers/postgres-atomic-telemetry-integration.ts'
const restartFixturePath = process.env.ATOMIC_TELEMETRY_RESTART_FIXTURE
if (
  restartFixturePath &&
  (!isAbsolute(restartFixturePath) ||
    !relative(process.cwd(), restartFixturePath).startsWith('..'))
)
  throw new Error('Restart fixture must be outside the checkout')
const portText = process.env.ATOMIC_TELEMETRY_SYNTHETIC_TEST_PORT
const port = Number(portText)
if (
  process.argv.length !== 2 ||
  process.env.ATOMIC_TELEMETRY_SYNTHETIC_TEST_DISPOSABLE !== 'yes' ||
  typeof portText !== 'string' ||
  !/^[0-9]{4,5}$/.test(portText) ||
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535
)
  throw new Error(
    'Explicit disposable loopback PostgreSQL port required; no arguments accepted',
  )
const sql = postgres({
  host: '127.0.0.1',
  port,
  database: 'fixture',
  username: 'fixture',
  password: '',
  ssl: false,
  max: 10,
  connect_timeout: 3,
})
try {
  const identity = (
    await sql`SELECT current_database() AS database,current_user AS user`
  )[0]
  assert.equal(identity?.database, 'fixture')
  assert.equal(identity?.user, 'fixture')
  const full = await loadMigrationCatalog()
  const catalog = catalogThrough(full, '0022_connector_successor_proofs')
  const existing = Number(
    (
      await sql`SELECT count(*)::int AS n FROM public.open3dfarm_migrations`.catch(
        () => [{ n: 0 }],
      )
    )[0]?.n,
  )
  if (existing > catalog.length)
    throw new Error(
      'Atomic telemetry runner requires a fresh fixture DB; it applies 0001–0022 itself and found ' +
        existing +
        ' migrations',
    )
  await runMigrations(sql, catalog, { kind: 'up' })
  const rows =
    await sql`SELECT position,id,checksum FROM public.open3dfarm_migrations ORDER BY position`
  assert.equal(validateMigrationHistory(catalog, [...rows]), catalog.length)
  assert.equal(
    (
      await sql`SELECT to_regclass('farm.connector_credential_proofs')::text AS name`
    )[0]?.name,
    'farm.connector_credential_proofs',
  )
  const checks = await testPostgresAtomicTelemetry(
    sql,
    port,
    restartFixturePath,
  )
  console.log(
    JSON.stringify({
      result: 'passed',
      checks,
      cleanup: {
        connectionsClosed: true,
        fixtureRows: 'retained for caller-owned disposable database teardown',
      },
    }),
  )
} finally {
  await sql.end({ timeout: 3 })
}
