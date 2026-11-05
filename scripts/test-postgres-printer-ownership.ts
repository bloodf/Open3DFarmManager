// Opt-in synthetic fixture. Caller owns the disposable loopback database and its teardown.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import {
  loadMigrationCatalog,
  validateMigrationHistory,
} from './db/migrations.ts'
import { testPostgresPrinterOwnership } from '../tests/helpers/postgres-printer-ownership-integration.ts'
import { testPrinterOwnershipRaces } from '../tests/helpers/postgres-printer-ownership-races.ts'

const portText = process.env.PRINTER_OWNERSHIP_SYNTHETIC_TEST_PORT
const port = Number(portText)
if (
  process.argv.length !== 2 ||
  process.env.PRINTER_OWNERSHIP_SYNTHETIC_TEST_DISPOSABLE !== 'yes' ||
  !portText ||
  !/^[0-9]{4,5}$/.test(portText) ||
  port < 1024 ||
  port > 65535
)
  throw new Error(
    'Explicit disposable loopback PostgreSQL port required; no arguments accepted',
  )
const role = 'printer_ownership_fixture_' + randomUUID().replaceAll('-', '')
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
const runtime = postgres({
  ...options,
  username: role,
  connection: { application_name: 'printer-ownership-fixture' },
})
let roleCreated = false
let checks: string[] = []
try {
  assert.equal(
    (await admin`SELECT current_database() AS name, current_user AS actor`)[0]
      ?.name,
    'fixture',
  )
  assert.equal((await admin`SELECT current_user AS actor`)[0]?.actor, 'fixture')
  const fullCatalog = await loadMigrationCatalog()
  const catalog = fullCatalog.slice(0, 15)
  assert.equal(catalog.length, 15)
  assert.equal(catalog[14]?.id, '0015_printer_ownership')
  assert.ok(catalog.some((entry) => entry.id.startsWith('0011_')))
  assert.ok(catalog.some((entry) => entry.id.startsWith('0015_')))
  const history =
    await admin`SELECT position, id, checksum FROM public.open3dfarm_migrations ORDER BY position`
  assert.equal(validateMigrationHistory(catalog, [...history]), catalog.length)
  await admin`CREATE ROLE ${admin(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_printer_ownership`
  roleCreated = true
  checks = [
    ...(await testPostgresPrinterOwnership(admin, runtime)),
    ...(await testPrinterOwnershipRaces(admin, runtime)),
  ]
} finally {
  await runtime.end({ timeout: 3 })
  try {
    if (roleCreated) await admin`DROP ROLE ${admin(role)}`
  } finally {
    await admin.end({ timeout: 3 })
  }
}
console.log(
  JSON.stringify({
    result: 'passed',
    checks,
    cleanup: {
      runtimeRoleRemoved: roleCreated,
      connectionsClosed: true,
      fixtureRows: 'caller-owned disposable database',
    },
  }),
)
