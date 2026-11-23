import postgres from 'postgres'
import { createError, useRuntimeConfig } from 'nuxt/server'
import { PostgresSpoolLibraryImport } from '../../storage/postgres-spool-library-import.ts'
import { canonicalOrigin } from './spoolman-source.ts'
import { validateSpoolImportRole } from './role-policy.ts'

export interface SpoolImportRuntime {
  importer: PostgresSpoolLibraryImport
  /** Exact origins the server may read a Spoolman from; empty disables API import. */
  allowedOrigins: readonly string[]
  fetch?: typeof fetch
}
let instance: Promise<SpoolImportRuntime> | undefined
let pool: ReturnType<typeof postgres> | undefined
export function spoolImportRuntime(): Promise<SpoolImportRuntime> {
  const raw: unknown = useRuntimeConfig()['spoolLibraryImport']
  if (
    !raw ||
    typeof raw !== 'object' ||
    !('enabled' in raw) ||
    raw.enabled !== true
  )
    throw createError({
      status: 404,
      message: 'Importação da biblioteca de filamentos indisponível.',
    })
  if (instance) return instance
  instance = (async () => {
    if (
      !('databaseUrl' in raw) ||
      typeof raw.databaseUrl !== 'string' ||
      raw.databaseUrl.length > 2048
    )
      throw new Error('Invalid configuration')
    const url = new URL(raw.databaseUrl)
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.username ||
      !url.password ||
      url.pathname.length < 2
    )
      throw new Error('Invalid configuration')
    const allowed =
      'allowedOrigins' in raw && typeof raw.allowedOrigins === 'string'
        ? raw.allowedOrigins
            .split(',')
            .map((value) => canonicalOrigin(value.trim()))
            .filter((value): value is string => value !== null)
        : []
    const sql = postgres(url.toString(), {
      max: 3,
      connect_timeout: 3,
      idle_timeout: 20,
      connection: { search_path: 'pg_catalog' },
    })
    pool = sql
    await validateSpoolImportRole(sql)
    return {
      importer: new PostgresSpoolLibraryImport(sql),
      allowedOrigins: allowed,
    }
  })().catch(async () => {
    await closeSpoolImportRuntime().catch(() => {})
    throw createError({
      status: 503,
      message: 'Importação da biblioteca de filamentos indisponível.',
    })
  })
  return instance
}
export async function closeSpoolImportRuntime() {
  const closing = pool
  pool = undefined
  instance = undefined
  await closing?.end({ timeout: 3 })
}
