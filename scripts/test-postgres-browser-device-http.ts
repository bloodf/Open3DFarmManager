import assert from 'node:assert/strict'
import postgres from 'postgres'
import {
  loadMigrationCatalog,
  validateMigrationHistory,
} from './db/migrations.ts'
import { testBrowserDeviceSqlAcceptance } from '../tests/helpers/postgres-browser-device-http-acceptance.ts'
const port = Number(process.env.BROWSER_DEVICE_HTTP_SYNTHETIC_TEST_PORT)
if (
  process.env.BROWSER_DEVICE_HTTP_TEST_DISPOSABLE !== 'yes' ||
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535 ||
  process.argv.length !== 2
)
  throw new Error('Disposable loopback fixture required')
const admin = postgres({
  host: '127.0.0.1',
  port,
  database: 'fixture',
  username: 'fixture',
  ssl: false,
  max: 6,
  connect_timeout: 3,
})
try {
  const identity = (
    await admin`SELECT current_database() AS database,current_user AS username`
  )[0]
  assert.deepEqual(
    { ...identity },
    { database: 'fixture', username: 'fixture' },
  )
  const catalog = await loadMigrationCatalog(),
    rows =
      await admin`SELECT position,id,checksum FROM public.open3dfarm_migrations ORDER BY position`
  assert.equal(validateMigrationHistory(catalog, [...rows]), catalog.length)
  console.log(
    JSON.stringify({
      result: 'passed',
      checks: await testBrowserDeviceSqlAcceptance(admin, port),
      journal: catalog.length,
    }),
  )
} finally {
  await admin.end({ timeout: 3 })
}
