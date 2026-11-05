// Explicit disposable loopback PostgreSQL only. Caller owns the fixture and final data teardown.
import assert from 'node:assert/strict'
import postgres from 'postgres'
import {
  loadMigrationCatalog,
  validateMigrationHistory,
} from './db/migrations.ts'
import { testPostgresCredentialIssuance } from '../tests/helpers/postgres-credential-issuance-integration.ts'

const portText = process.env.CREDENTIAL_SYNTHETIC_TEST_PORT
const port = Number(portText)
if (
  process.argv.length !== 2 ||
  process.env.CREDENTIAL_SYNTHETIC_TEST_DISPOSABLE !== 'yes' ||
  typeof portText !== 'string' ||
  !/^[0-9]{4,5}$/.test(portText) ||
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535
)
  throw new Error(
    'Explicit disposable loopback PostgreSQL port required; no arguments accepted',
  )
const admin = postgres({
  host: '127.0.0.1',
  port,
  database: 'fixture',
  username: 'fixture',
  password: '',
  ssl: false,
  max: 8,
  connect_timeout: 3,
})
try {
  const identity = (
    await admin`SELECT current_database() AS database,current_user AS user`
  )[0]
  assert.equal(identity?.database, 'fixture')
  assert.equal(identity?.user, 'fixture')
  const catalog = (await loadMigrationCatalog()).slice(0, 10)
  assert.equal(catalog.length, 10, 'Migrations0001–0010 are required')
  const rows =
    await admin`SELECT position,id,checksum FROM public.open3dfarm_migrations WHERE position<=10 ORDER BY position`
  assert.equal(validateMigrationHistory(catalog, [...rows]), 10)
  assert.equal(
    (
      await admin`SELECT to_regclass('farm.connector_credentials')::text AS name`
    )[0]?.name,
    'farm.connector_credentials',
  )
  const checks = await testPostgresCredentialIssuance(admin, port)
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
  await admin.end({ timeout: 3 })
}
