// Caller owns a disposable loopback PostgreSQL database with the maintained full migration journal.
import assert from 'node:assert/strict'
import postgres from 'postgres'
import {
  loadMigrationCatalog,
  validateMigrationHistory,
} from './db/migrations.ts'
import { testPostgresPauseAuthority } from '../tests/helpers/postgres-pause-authority-integration.ts'
const portText = process.env.PAUSE_AUTHORITY_SYNTHETIC_TEST_PORT,
  port = Number(portText)
if (
  process.env.PAUSE_AUTHORITY_SYNTHETIC_TEST_DISPOSABLE !== 'yes' ||
  !portText ||
  !/^\d{4,5}$/.test(portText) ||
  port < 1024 ||
  port > 65535 ||
  process.argv.length !== 2
)
  throw new Error('Explicit disposable loopback PostgreSQL fixture required')
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
    history =
      await admin`SELECT position,id,checksum FROM public.open3dfarm_migrations ORDER BY position`
  assert.ok(catalog.some((entry) => entry.id === '0018_pause_authority'))
  assert.equal(validateMigrationHistory(catalog, [...history]), catalog.length)
  console.log(
    JSON.stringify({
      result: 'passed',
      checks: await testPostgresPauseAuthority(admin, port),
      journal: catalog.length,
    }),
  )
} finally {
  await admin.end({ timeout: 3 })
}
