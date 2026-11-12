import type { Sql } from 'postgres'
import {
  runMigrations,
  validateMigrationHistory,
  type migrationCatalog,
} from '../../../../../scripts/db/migrations.ts'

type Catalog = ReturnType<typeof migrationCatalog>
/** `ahead`: journal extends the catalog (newer deploy ran first); treated as ready. */
export type SchemaState = 'current' | 'ahead' | 'pending' | 'mismatch'

export type StartupFailureCode =
  | 'invalid-config'
  | 'migrations-unavailable'
  | 'unreachable'
  | 'migration-failed'
  | 'schema-pending'
  | 'schema-mismatch'

/** Fixed messages only: driver errors carry hosts and user names. */
export const STARTUP_FAILURE_MESSAGES: Record<StartupFailureCode, string> = {
  'invalid-config': 'invalid database configuration',
  'migrations-unavailable': 'migration files unavailable',
  unreachable: 'database unreachable',
  'migration-failed': 'migration failed',
  'schema-pending': 'schema has pending migrations',
  'schema-mismatch': 'schema does not match this build',
}

export class DatabaseStartupError extends Error {
  readonly code: StartupFailureCode
  constructor(code: StartupFailureCode) {
    super(STARTUP_FAILURE_MESSAGES[code])
    this.code = code
  }
}

/** Read-only comparison of the migration journal with the local catalog.
 * `onQuery` receives each pending query so a caller can cancel it on timeout. */
export async function schemaState(
  sql: Sql,
  catalog: Catalog,
  onQuery: (query: { cancel(): void }) => void = () => {},
): Promise<SchemaState> {
  const exists = sql`SELECT to_regclass('public.open3dfarm_migrations') AS name`
  onQuery(exists)
  const [row] = await exists
  if (!row?.name) return 'pending'
  const journal = sql`SELECT position, id, checksum FROM public.open3dfarm_migrations ORDER BY position`
  onQuery(journal)
  const history = [...(await journal)]
  try {
    const applied = validateMigrationHistory(
      catalog,
      history.slice(0, catalog.length),
    )
    if (history.length > catalog.length) return 'ahead'
    return applied === catalog.length ? 'current' : 'pending'
  } catch {
    return 'mismatch'
  }
}

/** Fails closed: resolves only when the schema equals (or extends) the catalog. */
export async function prepareSchema(
  sql: Sql,
  catalog: Catalog,
  mode: 'verify' | 'apply',
): Promise<void> {
  let state: SchemaState
  try {
    state = await schemaState(sql, catalog)
  } catch {
    throw new DatabaseStartupError('unreachable')
  }
  if (state === 'pending' && mode === 'apply') {
    try {
      await runMigrations(sql, catalog, { kind: 'up' })
      state = await schemaState(sql, catalog)
    } catch {
      throw new DatabaseStartupError('migration-failed')
    }
  }
  if (state === 'pending') throw new DatabaseStartupError('schema-pending')
  if (state === 'mismatch') throw new DatabaseStartupError('schema-mismatch')
}

export type Readiness =
  'ok' | 'ahead' | 'unavailable' | 'schema-pending' | 'schema-mismatch'

/** Bounded; cancels the in-flight query on timeout; never exposes driver errors. */
export async function databaseReadiness(
  sql: Sql,
  catalog: Catalog,
  timeoutMs = 1500,
): Promise<Readiness> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const pending = new Set<{ cancel(): void }>()
  try {
    const state = await Promise.race([
      schemaState(sql, catalog, (query) => pending.add(query)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs)
      }),
    ])
    return state === 'current'
      ? 'ok'
      : state === 'ahead'
        ? 'ahead'
        : `schema-${state}`
  } catch {
    for (const query of pending) {
      try {
        query.cancel()
      } catch {
        /* already settled */
      }
    }
    return 'unavailable'
  } finally {
    clearTimeout(timer)
  }
}

/** HTTP mapping for /readyz; null means the database runtime is disabled. */
export function readinessHttp(database: Readiness | null) {
  const value = database ?? 'disabled'
  const ready = value === 'ok' || value === 'ahead' || value === 'disabled'
  return {
    status: ready ? 200 : 503,
    body: {
      status: ready ? 'ok' : 'unavailable',
      checks: { database: value },
    },
  }
}
