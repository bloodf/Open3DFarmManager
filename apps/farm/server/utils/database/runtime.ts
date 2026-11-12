import { pathToFileURL } from 'node:url'
import postgres, { type Sql } from 'postgres'
import { z } from 'zod'
import {
  loadMigrationCatalog,
  type migrationCatalog,
} from '../../../../../scripts/db/migrations.ts'
import { databasePhase } from './phase.ts'
import {
  databaseReadiness,
  DatabaseStartupError,
  prepareSchema,
  type Readiness,
} from './schema.ts'

const Config = z.strictObject({
  enabled: z.literal(true),
  databaseUrl: z
    .string()
    .min(1)
    .max(2048)
    .refine((value) => {
      try {
        const url = new URL(value)
        return (
          ['postgres:', 'postgresql:'].includes(url.protocol) &&
          !!url.hostname &&
          url.pathname.length > 1
        )
      } catch {
        return false
      }
    }),
  migrations: z.enum(['verify', 'apply']),
  migrationsDir: z.string().min(1).max(2048),
})
export type DatabaseRuntimeConfig = z.infer<typeof Config>

/** Unset/false: undefined. Anything else that is not a valid enabled config fails closed. */
export function parseDatabaseRuntimeConfig(
  raw: unknown,
): DatabaseRuntimeConfig | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object') throw new DatabaseStartupError('invalid-config')
  const enabled: unknown = Reflect.get(raw, 'enabled')
  if (enabled === undefined || enabled === false) return undefined
  const parsed = enabled === true ? Config.safeParse(raw) : undefined
  if (!parsed?.success) throw new DatabaseStartupError('invalid-config')
  return parsed.data
}

function target(value: string) {
  const url = new URL(value)
  return `${url.hostname}:${url.port || '5432'}${url.pathname}`
}

/** Every enabled feature must point at the database whose schema was verified. */
export function assertSameDatabaseTargets(
  config: DatabaseRuntimeConfig,
  root: unknown,
): void {
  const expected = target(config.databaseUrl)
  if (typeof root !== 'object' || root === null) return
  for (const [key, feature] of Object.entries(root)) {
    if (
      key === 'database' ||
      typeof feature !== 'object' ||
      feature === null ||
      Reflect.get(feature, 'enabled') !== true
    )
      continue
    for (const [field, value] of Object.entries(feature)) {
      if (!/databaseurl$/i.test(field) || value === '') continue
      try {
        if (typeof value === 'string' && target(value) === expected) continue
      } catch {
        /* fall through to the fixed failure */
      }
      throw new DatabaseStartupError('invalid-config')
    }
  }
}

type Active = {
  sql: Sql
  catalog: ReturnType<typeof migrationCatalog>
}
let active: Active | undefined
let generation = 0

/** Rejects (so the caller can exit) on unreachable DB or schema mismatch.
 * If closed while starting, releases the pool and publishes nothing. */
export async function startDatabaseRuntime(
  config: DatabaseRuntimeConfig,
): Promise<void> {
  const mine = ++generation
  let catalog: Active['catalog']
  try {
    catalog = await loadMigrationCatalog(
      pathToFileURL(config.migrationsDir.replace(/\/?$/, '/')),
    )
  } catch {
    throw new DatabaseStartupError('migrations-unavailable')
  }
  const sql = postgres(config.databaseUrl, {
    max: 2,
    connect_timeout: 5,
    idle_timeout: 20,
    // Migrations SET LOCAL their own, longer limits inside their transaction.
    connection: { statement_timeout: 2000, lock_timeout: 1000 },
  })
  try {
    await prepareSchema(sql, catalog, config.migrations)
  } catch (error) {
    await sql.end({ timeout: 3 })
    throw error
  }
  if (mine !== generation) {
    await sql.end({ timeout: 3 })
    return
  }
  active = { sql, catalog }
}

const CACHE_MS = 1000
let inflight: Promise<Readiness> | undefined
let cached: { at: number; value: Readiness } | undefined

/** null: database runtime disabled. Not started/failed reports unavailable.
 * Single-flight with a short cache so probes cannot stack queries. */
export async function currentDatabaseReadiness(): Promise<Readiness | null> {
  if (databasePhase() === 'disabled') return null
  const current = active
  if (!current) return 'unavailable'
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value
  inflight ??= databaseReadiness(current.sql, current.catalog)
    .then((value) => {
      cached = { at: Date.now(), value }
      return value
    })
    .finally(() => {
      inflight = undefined
    })
  return inflight
}

export async function closeDatabaseRuntime(): Promise<void> {
  generation++
  cached = undefined
  const current = active
  active = undefined
  await current?.sql.end({ timeout: 3 })
}
