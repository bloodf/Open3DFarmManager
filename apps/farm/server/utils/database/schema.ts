import type { Sql } from 'postgres'
import {
  runMigrations,
  validateMigrationHistory,
  type migrationCatalog,
} from '../../../../../scripts/db/migrations.ts'

type Catalog = ReturnType<typeof migrationCatalog>
export type SchemaState = 'current' | 'pending' | 'mismatch'

/** Read-only comparison of the migration journal with the local catalog. */
export async function schemaState(
  sql: Sql,
  catalog: Catalog,
): Promise<SchemaState> {
  const [exists] =
    await sql`SELECT to_regclass('public.open3dfarm_migrations') AS name`
  if (!exists?.name) return 'pending'
  const history =
    await sql`SELECT position, id, checksum FROM public.open3dfarm_migrations ORDER BY position`
  let applied: number
  try {
    applied = validateMigrationHistory(catalog, [...history])
  } catch {
    return 'mismatch'
  }
  return applied === catalog.length ? 'current' : 'pending'
}

/** Fails closed: resolves only when the schema equals the catalog. */
export async function prepareSchema(
  sql: Sql,
  catalog: Catalog,
  mode: 'verify' | 'apply',
): Promise<void> {
  if (mode === 'apply') await runMigrations(sql, catalog, { kind: 'up' })
  const state = await schemaState(sql, catalog)
  if (state !== 'current') throw new Error(`Database schema is ${state}`)
}

export type Readiness =
  'ok' | 'unavailable' | 'schema-pending' | 'schema-mismatch'

/** Bounded; never exposes driver errors, hosts or credentials. */
export async function databaseReadiness(
  sql: Sql,
  catalog: Catalog,
  timeoutMs = 2000,
): Promise<Readiness> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const state = await Promise.race([
      schemaState(sql, catalog),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs)
      }),
    ])
    return state === 'current' ? 'ok' : `schema-${state}`
  } catch {
    return 'unavailable'
  } finally {
    clearTimeout(timer)
  }
}
