// Explicit disposable loopback fixture only. Caller owns all synthetic rows and cluster teardown.
import assert from 'node:assert/strict'
import postgres from 'postgres'
import {
  loadMigrationCatalog,
  validateMigrationHistory,
} from './db/migrations.ts'
import { testPostgresConnectorRevocation } from '../tests/helpers/postgres-connector-revocation-integration.ts'
const portText = process.env.REVOCATION_SYNTHETIC_TEST_PORT
const port = Number(portText)
if (
  process.argv.length !== 2 ||
  process.env.REVOCATION_SYNTHETIC_TEST_DISPOSABLE !== 'yes' ||
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
  const catalog = (await loadMigrationCatalog()).slice(0, 11)
  assert.equal(catalog.length, 11, 'Migrations0001–0011 are required')
  const rows =
    await sql`SELECT position,id,checksum FROM public.open3dfarm_migrations WHERE position<=11 ORDER BY position`
  assert.equal(validateMigrationHistory(catalog, [...rows]), 11)
  assert.equal(
    (
      await sql`SELECT to_regclass('farm.connector_revocations')::text AS name`
    )[0]?.name,
    'farm.connector_revocations',
  )
  const checks = await testPostgresConnectorRevocation(sql, port)
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
