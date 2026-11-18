import postgres from 'postgres'
import { createError, useRuntimeConfig } from 'nuxt/server'
import {
  PostgresSpoolmanSettings,
  type SpoolmanSettingsStore,
} from '../../storage/postgres-spoolman-settings.ts'
import { validateSpoolmanSettingsRole } from './role-policy.ts'

export interface SpoolmanSettingsRuntime {
  settings: SpoolmanSettingsStore
}
let instance: Promise<SpoolmanSettingsRuntime> | undefined
let pool: ReturnType<typeof postgres> | undefined
export function spoolmanSettingsRuntime(): Promise<SpoolmanSettingsRuntime> {
  const raw: unknown = useRuntimeConfig()['spoolmanSettings']
  if (
    !raw ||
    typeof raw !== 'object' ||
    !('enabled' in raw) ||
    raw.enabled !== true
  )
    throw createError({
      status: 404,
      message: 'Configuração do Spoolman indisponível.',
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
    await validateSpoolmanSettingsRole(sql)
    return { settings: new PostgresSpoolmanSettings(sql) }
  })().catch(async () => {
    await closeSpoolmanSettingsRuntime().catch(() => {})
    throw createError({
      status: 503,
      message: 'Configuração do Spoolman indisponível.',
    })
  })
  return instance
}
export async function closeSpoolmanSettingsRuntime() {
  const closing = pool
  pool = undefined
  instance = undefined
  await closing?.end({ timeout: 3 })
}
