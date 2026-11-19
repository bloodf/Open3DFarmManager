import postgres from 'postgres'
import { createLogger } from '@open3dfarmmanager/shared'
import { useRuntimeConfig } from 'nuxt/server'
import { loadTelemetryVerificationKeys } from '../services/telemetry-key-registry.ts'
import { parseTelemetryRuntimeConfig } from '../services/telemetry-runtime-config.ts'
import { createBlobStore } from '../utils/library/blob-store.ts'
import {
  PostgresConnectorLibraryDownloads,
  startConnectorLibraryDownload,
} from '../utils/library/connector-download.ts'

const logger = createLogger('farm-library')
const RETRY_MIN_MS = 1000
const RETRY_MAX_MS = 30000

/**
 * The Connector library download (`GET /api/connector/library/{sha256}`) is
 * served only when the library is enabled with a server-mode directory and the
 * Connector credential policy (the telemetry one) is configured. Otherwise the
 * route stays at 503. Startup never blocks: a database that is not reachable
 * yet is retried with a bounded backoff.
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
    typeof library.directory !== 'string' ||
    !library.directory ||
    telemetry.kind !== 'enabled'
  )
    return
  const { databaseUrl, directory } = library
  const credentials = telemetry.config

  let closing = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let stop: (() => void) | undefined
  let sql: ReturnType<typeof postgres> | undefined

  async function start(): Promise<void> {
    const pool = postgres(databaseUrl, {
      max: 3,
      connect_timeout: 3,
      idle_timeout: 20,
      connection: {
        statement_timeout: 5000,
        lock_timeout: 2000,
        search_path: 'pg_catalog',
      },
    })
    try {
      const [blobs, publicKeys] = await Promise.all([
        createBlobStore(directory),
        loadTelemetryVerificationKeys(credentials.publicKeyRegistryPath),
      ])
      if (closing) throw new Error('closing')
      const records = new PostgresConnectorLibraryDownloads(pool)
      stop = startConnectorLibraryDownload({
        credentials: {
          issuer: credentials.issuer,
          audience: credentials.audience,
          ttlSeconds: credentials.tokenTtlSeconds,
          publicKeys,
        },
        enrollments: records,
        findBlob: (farmId, sha256) => records.findBlob(farmId, sha256),
        audit: (entry) => records.audit(entry),
        blobs,
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
      logger.info('library-download-active')
    } catch (error) {
      logger.error('library-download-unavailable', { error })
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
