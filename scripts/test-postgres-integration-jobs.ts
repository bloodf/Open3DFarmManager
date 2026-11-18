// Synthetic PostgreSQL only. Caller owns the database, migrations (through 0044) and teardown.
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { testPostgresIntegrationJobs } from '../tests/helpers/postgres-integration-jobs-integration.ts'

const portText = process.env.INTEGRATION_JOBS_SYNTHETIC_TEST_PORT
const port = Number(portText)
if (
  process.argv.length !== 2 ||
  process.env.INTEGRATION_JOBS_SYNTHETIC_TEST_DISPOSABLE !== 'yes' ||
  typeof portText !== 'string' ||
  !/^[0-9]{4,5}$/.test(portText) ||
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535
)
  throw new Error(
    'Explicit disposable loopback PostgreSQL port required; no arguments accepted',
  )

const suffix = randomUUID().replaceAll('-', '')
const role = 'integration_jobs_fixture_' + suffix
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
let created = false
let checks: string[] = []
try {
  const applied = (
    await admin`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'farm' AND table_name = 'integration_jobs'`
  )[0]?.n
  if (applied !== 1)
    throw new Error('Apply migration 0044 before running this fixture')
  // The API runtime login holds both the jobs and the delivery role.
  await admin`CREATE ROLE ${admin(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_integration_jobs, farm_integration_delivery`
  created = true
  checks = await testPostgresIntegrationJobs(admin, runtime)
} finally {
  try {
    await runtime.end({ timeout: 3 })
  } finally {
    try {
      if (created) await admin`DROP ROLE ${admin(role)}`
    } finally {
      await admin.end({ timeout: 3 })
    }
  }
}
console.log(JSON.stringify({ result: 'passed', checks }))
