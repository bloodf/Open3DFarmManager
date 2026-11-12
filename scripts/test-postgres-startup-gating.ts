// Opt-in: needs a disposable PostgreSQL. Set STARTUP_GATING_DATABASE_URL (loopback, fresh database).
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { loadMigrationCatalog } from './db/migrations.ts'
import {
  databaseReadiness,
  prepareSchema,
  schemaState,
} from '../apps/farm/server/utils/database/schema.ts'

const url = process.env.STARTUP_GATING_DATABASE_URL
if (!url || new URL(url).hostname !== '127.0.0.1')
  throw new Error('Set STARTUP_GATING_DATABASE_URL to a loopback disposable DB')
const catalog = await loadMigrationCatalog(
  new URL('../infra/db/migrations/', import.meta.url),
)
const sql = postgres(url, { max: 2, connect_timeout: 5 })
try {
  assert.equal(await schemaState(sql, catalog), 'pending')
  assert.equal(await databaseReadiness(sql, catalog), 'schema-pending')
  await assert.rejects(prepareSchema(sql, catalog, 'verify'), /pending/)
  await prepareSchema(sql, catalog, 'apply')
  await prepareSchema(sql, catalog, 'verify')
  assert.equal(await databaseReadiness(sql, catalog), 'ok')
  await sql`UPDATE public.open3dfarm_migrations SET checksum = ${'0'.repeat(64)} WHERE position = 1`
  assert.equal(await databaseReadiness(sql, catalog), 'schema-mismatch')
  await assert.rejects(prepareSchema(sql, catalog, 'apply'), /does not match/)
  await sql`DELETE FROM public.open3dfarm_migrations WHERE position = ${catalog.length}`
  await sql`UPDATE public.open3dfarm_migrations SET checksum = ${catalog[0]!.checksum} WHERE position = 1`
  assert.equal(await schemaState(sql, catalog), 'pending')
  const dead = postgres(url.replace(/:\d+\//, ':1/'), { connect_timeout: 2 })
  assert.equal(await databaseReadiness(dead, catalog, 3000), 'unavailable')
  await dead.end({ timeout: 1 })
  console.log('startup gating integration: ok', fileURLToPath(import.meta.url))
} finally {
  await sql.end({ timeout: 3 })
}
