// Synthetic PostgreSQL only. An explicit fixture is caller-owned; otherwise the runner creates one.
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { testPostgresIntegrationApps } from '../tests/helpers/postgres-integration-apps-integration.ts'

const portText = process.env.INTEGRATION_APPS_SYNTHETIC_TEST_PORT
const admitted = process.env.INTEGRATION_APPS_SYNTHETIC_TEST_DISPOSABLE
if (
  process.argv.length === 2 &&
  portText === undefined &&
  admitted === undefined
) {
  const env: NodeJS.ProcessEnv = { ...process.env, OPENFARM_PG: 'local' }
  delete env.OPENFARM_TEST_DATABASE_URL
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('./test-postgres.ts', import.meta.url)),
      '--only',
      'test-postgres-integration-apps.ts',
    ],
    { env, stdio: 'inherit' },
  )
  if (result.error) throw result.error
  process.exit(result.status ?? 1)
}
const port = Number(portText)
if (
  process.argv.length !== 2 ||
  admitted !== 'yes' ||
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
const roles = {
  runtime: 'integration_apps_fixture_' + suffix,
  ownership: 'integration_apps_ownership_' + suffix,
}
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
const runtime = postgres({ ...options, username: roles.runtime })
const ownership = postgres({ ...options, username: roles.ownership })
const created: string[] = []
let checks: string[] = []
try {
  const applied = (
    await admin`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'farm' AND table_name = 'integration_app_grants' AND column_name = 'requires_approval'`
  )[0]?.n
  if (applied !== 1)
    throw new Error('Apply migration 0040 before running this fixture')
  await admin`CREATE ROLE ${admin(roles.runtime)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_integration_apps`
  created.push(roles.runtime)
  await admin`CREATE ROLE ${admin(roles.ownership)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_printer_ownership`
  created.push(roles.ownership)
  checks = await testPostgresIntegrationApps(admin, runtime, ownership)
} finally {
  try {
    await runtime.end({ timeout: 3 })
    await ownership.end({ timeout: 3 })
  } finally {
    try {
      for (const role of created) await admin`DROP ROLE ${admin(role)}`
    } finally {
      await admin.end({ timeout: 3 })
    }
  }
}
console.log(JSON.stringify({ result: 'passed', checks }))
