// Only for an explicitly disposable, isolated synthetic database.
import assert from 'node:assert/strict'
import postgres from 'postgres'
import {
  loadMigrationCatalog,
  validateMigrationHistory,
} from './db/migrations.ts'
import { testPostgresBrowserDeviceRegistry } from '../tests/helpers/postgres-browser-device-registry-integration.ts'

const portText = process.env.BROWSER_REGISTRY_SYNTHETIC_TEST_PORT
const port = Number(portText)
if (
  process.argv.length !== 2 ||
  process.env.BROWSER_REGISTRY_SYNTHETIC_TEST_DISPOSABLE !== 'yes' ||
  !portText ||
  !/^[0-9]{4,5}$/.test(portText) ||
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
    await admin`SELECT current_database() AS database, current_user AS username`
  )[0]
  assert.deepEqual(identity, { database: 'fixture', username: 'fixture' })
  const catalog = await loadMigrationCatalog()
  const history =
    await admin`SELECT position, id, checksum FROM public.open3dfarm_migrations ORDER BY position`
  assert.equal(validateMigrationHistory(catalog, [...history]), catalog.length)
  assert.ok(
    catalog.some((entry) => entry.id === '0013_browser_device_registry'),
  )
  console.log(
    JSON.stringify({
      result: 'passed',
      checks: await testPostgresBrowserDeviceRegistry(admin, port),
      migrations: 'full catalog and exact journal verified',
    }),
  )
} finally {
  await admin.end({ timeout: 3 })
}
