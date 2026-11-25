import postgres from 'postgres'
import { createError, useRuntimeConfig } from 'nuxt/server'
import { PostgresSpoolLibrary } from '../../storage/postgres-spool-library.ts'
import { validateSpoolLibraryRole } from './role-policy.ts'

let instance: Promise<PostgresSpoolLibrary> | undefined
let pool: ReturnType<typeof postgres> | undefined

export function spoolLibraryRuntime(): Promise<PostgresSpoolLibrary> {
  const raw: unknown = useRuntimeConfig()['spoolLibrary']
  if (
    !raw ||
    typeof raw !== 'object' ||
    !('enabled' in raw) ||
    raw.enabled !== true
  )
    throw createError({
      status: 404,
      message: 'Biblioteca de filamentos indisponível.',
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
    const sql = postgres(url.toString(), {
      max: 3,
      connect_timeout: 3,
      idle_timeout: 20,
      connection: {
        statement_timeout: 2000,
        lock_timeout: 1000,
        search_path: 'pg_catalog',
      },
    })
    pool = sql
    await validateSpoolLibraryRole(sql)
    return new PostgresSpoolLibrary(sql)
  })().catch(async () => {
    await closeSpoolLibraryRuntime().catch(() => {})
    throw createError({
      status: 503,
      message: 'Biblioteca de filamentos indisponível.',
    })
  })
  return instance
}

/** The validated pool, for spool moves (storage/postgres-spool-moves.ts). */
export async function spoolLibraryPool() {
  await spoolLibraryRuntime()
  if (!pool) throw new Error('Spool database unavailable')
  return pool
}

export async function closeSpoolLibraryRuntime() {
  const closing = pool
  pool = undefined
  instance = undefined
  await closing?.end({ timeout: 3 })
}
