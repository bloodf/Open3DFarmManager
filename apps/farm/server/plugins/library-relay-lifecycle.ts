import postgres from 'postgres'
import { createLogger } from '@open3dfarmmanager/shared'
import { useRuntimeConfig } from 'nuxt/server'
import { loadTelemetryVerificationKeys } from '../services/telemetry-key-registry.ts'
import { parseTelemetryRuntimeConfig } from '../services/telemetry-runtime-config.ts'
import { PostgresConnectorLibraryDownloads } from '../utils/library/connector-download.ts'
import { recordConnectorStorage } from '../utils/library/quota.ts'
import { startConnectorLibraryRelay } from '../utils/library/connector-relay.ts'

const logger = createLogger('farm-library')
const RETRY_MIN_MS = 1000
const RETRY_MAX_MS = 30000

/**
 * Starts the Connector library relay (Connector storage mode) when the library
 * is enabled and the Connector credential policy (the telemetry one) is
 * configured. It needs no library directory: the server keeps no file bytes in
 * this mode. Startup never blocks; an unreachable database is retried.
 */
export default defineNitroPlugin((nitro) => {
  if (import.meta.prerender) return
  const config: unknown = useRuntimeConfig()
  const section = (name: string): Record<string, unknown> | undefined => {
    const value =
      config && typeof config === 'object'
        ? Reflect.get(config, name)
        : undefined
    return value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : undefined
  }
  const library = section('library')
  const telemetry = parseTelemetryRuntimeConfig(section('connectorTelemetry'))
  if (
    library?.enabled !== true ||
    typeof library.databaseUrl !== 'string' ||
    telemetry.kind !== 'enabled'
  )
    return
  const { databaseUrl } = library
  const credentials = telemetry.config

  let closing = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let stop: (() => void) | undefined
  let sql: ReturnType<typeof postgres> | undefined

  async function start(): Promise<void> {
    const pool = postgres(databaseUrl, {
      max: 2,
      connect_timeout: 3,
      idle_timeout: 20,
      connection: {
        statement_timeout: 5000,
        lock_timeout: 2000,
        search_path: 'pg_catalog',
      },
    })
    try {
      const publicKeys = await loadTelemetryVerificationKeys(
        credentials.publicKeyRegistryPath,
      )
      if (closing) throw new Error('closing')
      stop = startConnectorLibraryRelay({
        credentials: {
          issuer: credentials.issuer,
          audience: credentials.audience,
          ttlSeconds: credentials.tokenTtlSeconds,
          publicKeys,
        },
        enrollments: new PostgresConnectorLibraryDownloads(pool),
        async recordStorage(identity, report) {
          const result = await recordConnectorStorage(pool, {
            ...identity,
            ...report,
          })
          return result.ok
        },
      }).stop
      sql = pool
    } catch (error) {
      await pool.end({ timeout: 1 }).catch(() => {})
      throw error
    }
  }

  async function attempt(delay: number): Promise<void> {
    if (closing) return
    try {
      await start()
      logger.info('library-relay-active')
    } catch (error) {
      logger.error('library-relay-unavailable', { error })
      if (closing) return
      timer = setTimeout(
        () => void attempt(Math.min(delay * 2, RETRY_MAX_MS)),
        delay,
      )
      timer.unref()
    }
  }
  void attempt(RETRY_MIN_MS)

  nitro.hooks.hook('close', async () => {
    closing = true
    clearTimeout(timer)
    stop?.()
    stop = undefined
    await sql?.end({ timeout: 3 })
    sql = undefined
  })
})
