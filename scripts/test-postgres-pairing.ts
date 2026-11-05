// Synthetic PostgreSQL only. Caller owns the disposable database and its rows.
import assert from 'node:assert/strict'
import postgres from 'postgres'
import {
  loadMigrationCatalog,
  validateMigrationHistory,
} from './db/migrations.ts'
import { testPostgresPairing } from '../tests/helpers/postgres-pairing-integration.ts'

const portText = process.env.PAIRING_SYNTHETIC_TEST_PORT
const port = Number(portText)
if (
  process.argv.length !== 2 ||
  process.env.PAIRING_SYNTHETIC_TEST_DISPOSABLE !== 'yes' ||
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
  max: 6,
  connect_timeout: 3,
})

try {
  const identity = (
    await admin`SELECT current_database() AS database, current_user AS user`
  )[0]
  assert.equal(identity?.database, 'fixture')
  assert.equal(identity?.user, 'fixture')

  const catalog = await loadMigrationCatalog()
  const requiredMigrations = catalog.slice(0, 10)
  assert.equal(
    requiredMigrations.length,
    10,
    'Migrations 0001–0010 are required',
  )
  const applied = await admin`
    SELECT position, id, checksum
    FROM public.open3dfarm_migrations
    WHERE position <= 10
    ORDER BY position
  `
  assert.equal(
    validateMigrationHistory(requiredMigrations, [...applied]),
    10,
    'Apply and verify migrations 0001–0010 before running this fixture',
  )

  for (const name of [
    'farm_enrollment_reader',
    'farm_telemetry_writer',
    'farm_session_runtime',
    'farm_password_auth',
    'farm_enrollment_approver',
    'farm_pairing_runtime',
    'farm_pairing_proof_runtime',
  ])
    assert.equal(
      (
        await admin`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ${name}`
      )[0]?.n,
      1,
      'Missing migration capability role',
    )

  const checks = await testPostgresPairing(admin, port)
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
