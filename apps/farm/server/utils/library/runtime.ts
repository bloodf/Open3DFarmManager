import postgres from 'postgres'
import { createError, useRuntimeConfig } from 'nuxt/server'
import { createLogger } from '@open3dfarmmanager/shared'
import { createBlobStore } from './blob-store.ts'
import { connectorLibraryRelay } from './connector-relay.ts'
import { PostgresLibrary } from './store.ts'
import type { LibraryRuntime } from './routes.ts'

const log = createLogger('farm-library')
let instance: Promise<LibraryRuntime> | undefined
let pool: ReturnType<typeof postgres> | undefined

/**
 * Disabled unless `library.enabled` and a `farm_library` login URL are set.
 * `library.directory` (`OPENFARM_LIBRARY_DIR`) enables server mode. Connector
 * mode always has the relay (`connector-relay.ts`): it resolves the running
 * hub per call, so a Connector upload answers 503 until the relay plugin has
 * started and while the target Connector is not polling.
 */
export function libraryRuntime(): Promise<LibraryRuntime> {
  const raw: unknown = useRuntimeConfig()['library']
  if (
    !raw ||
    typeof raw !== 'object' ||
    !('enabled' in raw) ||
    raw.enabled !== true
  )
    throw createError({ status: 404, message: 'Biblioteca indisponível.' })
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
      max: 5,
      connect_timeout: 3,
      idle_timeout: 20,
      connection: {
        statement_timeout: 5000,
        lock_timeout: 2000,
        search_path: 'pg_catalog',
      },
    })
    pool = sql
    const directory =
      'directory' in raw && typeof raw.directory === 'string'
        ? raw.directory
        : ''
    return {
      store: new PostgresLibrary(sql),
      relay: connectorLibraryRelay,
      ...(directory ? { blobs: await createBlobStore(directory) } : {}),
    }
  })().catch(async () => {
    log.error('library runtime unavailable')
    await closeLibraryRuntime().catch(() => {})
    throw createError({
      status: 503,
      message: 'Biblioteca indisponível. Tente novamente.',
    })
  })
  return instance
}

export async function closeLibraryRuntime() {
  const closing = pool
  pool = undefined
  instance = undefined
  await closing?.end({ timeout: 3 })
}
