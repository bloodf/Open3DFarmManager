import postgres from 'postgres'
import {
  loadMigrationCatalog,
  runMigrations,
  type MigrationAction,
} from './db/migrations.ts'

const port = Number(process.env.MIGRATION_SYNTHETIC_TEST_PORT)
const [command, expectedLastId, ...extra] = process.argv.slice(2)
if (
  process.env.MIGRATION_SYNTHETIC_TEST_DISPOSABLE !== 'yes' ||
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535
)
  throw new Error('Explicit disposable PostgreSQL port required')
if (
  extra.length ||
  (command !== 'up' && command !== 'down') ||
  (command === 'up' && expectedLastId !== undefined) ||
  (command === 'down' && !expectedLastId)
)
  throw new Error('Usage: migrate-disposable-db.ts up | down EXACT_LAST_ID')
let action: MigrationAction
if (command === 'up') action = { kind: 'up' }
else if (expectedLastId) action = { kind: 'down', expectedLastId }
else throw new Error('Rollback ID required')
const sql = postgres({
  hostname: '127.0.0.1',
  port,
  username: 'fixture',
  database: 'fixture',
  max: 2,
  connect_timeout: 3,
})
try {
  const changed = await runMigrations(sql, await loadMigrationCatalog(), action)
  console.log(JSON.stringify({ action: command, changed }))
} finally {
  await sql.end()
}
