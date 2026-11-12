import { pathToFileURL } from 'node:url'
import postgres, { type Sql } from 'postgres'
import { z } from 'zod'
import {
  loadMigrationCatalog,
  type migrationCatalog,
} from '../../../../../scripts/db/migrations.ts'
import { databaseReadiness, prepareSchema, type Readiness } from './schema.ts'

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

/** Disabled (or absent) config returns undefined; enabled-but-invalid throws. */
export function parseDatabaseRuntimeConfig(
  raw: unknown,
): DatabaseRuntimeConfig | undefined {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('enabled' in raw) ||
    raw.enabled !== true
  )
    return undefined
  const parsed = Config.safeParse(raw)
  if (!parsed.success) throw new Error('Invalid database runtime configuration')
  return parsed.data
}

type Active = {
  sql: Sql
  catalog: ReturnType<typeof migrationCatalog>
}
let active: Active | undefined

/** Rejects (so the server refuses to serve) on unreachable DB or schema mismatch. */
export async function startDatabaseRuntime(
  config: DatabaseRuntimeConfig,
): Promise<void> {
  const catalog = await loadMigrationCatalog(
    pathToFileURL(config.migrationsDir.replace(/\/?$/, '/')),
  )
  const sql = postgres(config.databaseUrl, {
    max: 2,
    connect_timeout: 5,
    idle_timeout: 20,
    connection: { statement_timeout: 30000, lock_timeout: 5000 },
  })
  try {
    await prepareSchema(sql, catalog, config.migrations)
  } catch (error) {
    await sql.end({ timeout: 3 })
    throw error
  }
  active = { sql, catalog }
}

/** null: database runtime disabled, so readiness has nothing to report. */
export function currentDatabaseReadiness(): Promise<Readiness> | null {
  return active ? databaseReadiness(active.sql, active.catalog) : null
}

export async function closeDatabaseRuntime(): Promise<void> {
  const current = active
  active = undefined
  await current?.sql.end({ timeout: 3 })
}
