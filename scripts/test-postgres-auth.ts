// Synthetic PostgreSQL only. Caller owns the database, migrations and final data teardown.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { testPostgresCredentials } from '../tests/helpers/postgres-credentials-integration.ts'
import { testPostgresFarmAuthorization } from '../tests/helpers/postgres-farm-authorization-integration.ts'

const portText = process.env.AUTHORIZATION_SYNTHETIC_TEST_PORT
const port = Number(portText)
if (
  process.argv.length !== 2 ||
  process.env.AUTHORIZATION_SYNTHETIC_TEST_DISPOSABLE !== 'yes' ||
  typeof portText !== 'string' ||
  !/^[0-9]{4,5}$/.test(portText) ||
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535
)
  throw new Error(
    'Explicit disposable loopback PostgreSQL port required; no arguments accepted',
  )

const role = 'auth_fixture_' + randomUUID().replaceAll('-', '')
const options = {
  host: '127.0.0.1',
  port,
  database: 'fixture',
  password: '',
  ssl: false as const,
  max: 6,
  connect_timeout: 3,
}
const admin = postgres({ ...options, username: 'fixture' })
const runtime = postgres({ ...options, username: role })
let roleCreated = false
const checks: string[] = []
try {
  assert.equal(
    (await admin`SELECT current_database() AS name`)[0]?.name,
    'fixture',
  )
  for (const table of [
    'farm.connector_enrollments',
    'farm.telemetry_events',
    'farm.session_accounts',
    'farm.account_sessions',
    'farm.password_credentials',
    'farm.auth_rate_limits',
    'farm.farms',
    'farm.memberships',
  ])
    assert.equal(
      (await admin`SELECT to_regclass(${table})::text AS name`)[0]?.name,
      table,
      'Apply migrations 0001 through 0006 before running this fixture',
    )
  for (const name of [
    'farm_enrollment_reader',
    'farm_telemetry_writer',
    'farm_session_runtime',
    'farm_password_auth',
    'farm_enrollment_approver',
  ])
    assert.equal(
      (
        await admin`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ${name}`
      )[0]?.n,
      1,
      'Missing migration capability role',
    )
  await admin`CREATE ROLE ${admin(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_password_auth`
  roleCreated = true
  checks.push(...(await testPostgresCredentials(admin, runtime)))
  checks.push(...(await testPostgresFarmAuthorization(admin, port)))
} finally {
  try {
    await runtime.end({ timeout: 3 })
  } finally {
    try {
      if (roleCreated) await admin`DROP ROLE ${admin(role)}`
    } finally {
      await admin.end({ timeout: 3 })
    }
  }
}
console.log(
  JSON.stringify({
    result: 'passed',
    checks,
    cleanup: {
      runtimeRoleRemoved: roleCreated,
      connectionsClosed: true,
      fixtureRows: 'retained for caller-owned disposable database teardown',
    },
  }),
)
