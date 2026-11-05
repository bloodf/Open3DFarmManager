// Explicit caller-owned disposable database only. No migrations or reset.
import assert from 'node:assert/strict'
import postgres from 'postgres'
import {
  loadMigrationCatalog,
  validateMigrationHistory,
} from './db/migrations.ts'
import { testPostgresPauseAuthority } from '../tests/helpers/postgres-pause-authority-integration.ts'

const portText = process.env.PAUSE_NEGOTIATION_TEST_PORT
const port = Number(portText)
if (
  process.env.PAUSE_NEGOTIATION_TEST_DISPOSABLE !== 'yes' ||
  !portText ||
  !/^\d{4,5}$/.test(portText) ||
  port < 1024 ||
  port > 65535 ||
  process.argv.length !== 2
) {
  throw new Error(
    'Explicit disposable loopback pause negotiation fixture required',
  )
}
const admin = postgres({
  host: '127.0.0.1',
  port,
  database: 'fixture',
  username: 'fixture',
  max: 6,
  connect_timeout: 3,
  connection: {
    statement_timeout: 2000,
    lock_timeout: 1000,
    transaction_timeout: 10000,
  },
})
try {
  const identity = (
    await admin`SELECT current_database() AS database,current_user AS username`
  )[0]
  assert.deepEqual(
    { ...identity },
    { database: 'fixture', username: 'fixture' },
  )
  const catalog = await loadMigrationCatalog()
  const history =
    await admin`SELECT position,id,checksum FROM public.open3dfarm_migrations ORDER BY position`
  assert.equal(catalog[17]?.id, '0018_pause_authority')
  assert.equal(validateMigrationHistory(catalog, [...history]), catalog.length)
  const checks = await testPostgresPauseAuthority(
    admin,
    port,
    undefined,
    'negotiation',
  )
  console.log(
    JSON.stringify({
      checks,
      journalCount: catalog.length,
      authority: 'negotiation metadata only',
      rtc: false,
      commandExecution: false,
    }),
  )
} finally {
  await admin.end({ timeout: 3 })
}
