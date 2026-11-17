// Synthetic PostgreSQL only. Caller owns the database, migrations (through 0034) and teardown.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { testPostgresMembers } from '../tests/helpers/postgres-members-integration.ts'

const portText = process.env.MEMBERS_SYNTHETIC_TEST_PORT
const port = Number(portText)
if (
  process.argv.length !== 2 ||
  process.env.MEMBERS_SYNTHETIC_TEST_DISPOSABLE !== 'yes' ||
  typeof portText !== 'string' ||
  !/^[0-9]{4,5}$/.test(portText) ||
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535
)
  throw new Error(
    'Explicit disposable loopback PostgreSQL port required; no arguments accepted',
  )

const role = 'members_fixture_' + randomUUID().replaceAll('-', '')
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
let checks: string[] = []
try {
  assert.equal(
    (
      await admin`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'farm' AND table_name = 'account_invites' AND column_name = 'revoked_at'`
    )[0]?.n,
    1,
    'Apply migration 0034 before running this fixture',
  )
  await admin`CREATE ROLE ${admin(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_account_registration`
  roleCreated = true
  checks = await testPostgresMembers(admin, runtime)
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
console.log(JSON.stringify({ result: 'passed', checks }))
