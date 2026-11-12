// Synthetic PostgreSQL only. Caller owns the database, migrations (through 0024) and teardown.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { testPostgresRegistration } from '../tests/helpers/postgres-registration-integration.ts'

const portText = process.env.REGISTRATION_SYNTHETIC_TEST_PORT
const port = Number(portText)
if (
  process.argv.length !== 2 ||
  process.env.REGISTRATION_SYNTHETIC_TEST_DISPOSABLE !== 'yes' ||
  typeof portText !== 'string' ||
  !/^[0-9]{4,5}$/.test(portText) ||
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535
)
  throw new Error(
    'Explicit disposable loopback PostgreSQL port required; no arguments accepted',
  )

const role = 'registration_fixture_' + randomUUID().replaceAll('-', '')
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
    (await admin`SELECT to_regclass('farm.account_invites')::text AS name`)[0]
      ?.name,
    'farm.account_invites',
    'Apply migration 0024 before running this fixture',
  )
  await admin`CREATE ROLE ${admin(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_account_registration`
  roleCreated = true
  checks = await testPostgresRegistration(admin, runtime)
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
