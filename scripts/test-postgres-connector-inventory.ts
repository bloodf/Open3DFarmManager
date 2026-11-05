// Opt-in synthetic fixture. Caller owns the disposable loopback database and its teardown.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import {
  loadMigrationCatalog,
  validateMigrationHistory,
} from './db/migrations.ts'
import { testPostgresConnectorInventory } from '../tests/helpers/postgres-connector-inventory-integration.ts'

const portText = process.env.INVENTORY_SYNTHETIC_TEST_PORT
const port = Number(portText)
if (
  process.argv.length !== 2 ||
  process.env.INVENTORY_SYNTHETIC_TEST_DISPOSABLE !== 'yes' ||
  !portText ||
  !/^[0-9]{4,5}$/.test(portText) ||
  port < 1024 ||
  port > 65535
)
  throw new Error(
    'Explicit disposable loopback PostgreSQL port required; no arguments accepted',
  )
const role = 'inventory_fixture_' + randomUUID().replaceAll('-', '')
const authRole = 'inventory_auth_fixture_' + randomUUID().replaceAll('-', '')
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
  connection: { application_name: 'connector-inventory-fixture' },
})
const authSql = postgres({ ...options, username: authRole })
let roleCreated = false
let authRoleCreated = false
let checks: string[] = []
try {
  assert.equal(
    (await admin`SELECT current_database() AS name, current_user AS actor`)[0]
      ?.name,
    'fixture',
  )
  assert.equal((await admin`SELECT current_user AS actor`)[0]?.actor, 'fixture')
  const catalog = await loadMigrationCatalog()
  assert.ok(catalog.some((entry) => entry.id.startsWith('0011_')))
  assert.ok(catalog.some((entry) => entry.id.startsWith('0012_')))
  const history =
    await admin`SELECT position, id, checksum FROM public.open3dfarm_migrations ORDER BY position`
  assert.equal(validateMigrationHistory(catalog, [...history]), catalog.length)
  await admin`CREATE ROLE ${admin(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_connector_inventory`
  roleCreated = true
  await admin`CREATE ROLE ${admin(authRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_password_auth, farm_session_runtime`
  authRoleCreated = true
  checks = await testPostgresConnectorInventory(admin, runtime, authSql)
} finally {
  await runtime.end({ timeout: 3 })
  await authSql.end({ timeout: 3 })
  try {
    if (roleCreated) await admin`DROP ROLE ${admin(role)}`
    if (authRoleCreated) await admin`DROP ROLE ${admin(authRole)}`
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
      authRoleRemoved: authRoleCreated,
      connectionsClosed: true,
      fixtureRows: 'caller-owned disposable database',
    },
  }),
)
