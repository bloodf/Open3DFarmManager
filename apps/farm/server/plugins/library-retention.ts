import postgres from 'postgres'
import { createLogger } from '@open3dfarmmanager/shared'
import { useRuntimeConfig } from 'nuxt/server'
import { createBlobStore } from '../utils/library/blob-store.ts'
import {
  parseLibraryRetentionConfig,
  runLibraryRetention,
} from '../utils/library/retention.ts'

const logger = createLogger('farm-server')

/** Library purge next to the telemetry prune; off unless `libraryRetention.enabled`. */
export default defineNitroPlugin((nitro) => {
  if (import.meta.prerender) return
  const config = parseLibraryRetentionConfig(
    Reflect.get(useRuntimeConfig(), 'libraryRetention'),
  )
  if (!config) return
  const sql = postgres(config.databaseUrl, {
    max: 1,
    connect_timeout: 3,
    idle_timeout: 20,
    connection: {
      statement_timeout: 5000,
      lock_timeout: 2000,
      options: '-c role=farm_library_retention',
      search_path: 'pg_catalog',
    },
  })
  let running = false
  const run = async () => {
    if (running) return
    running = true
    try {
      // Server-mode purge needs the library directory; Connector-mode purge needs a Connector transport (none wired yet: those blobs are reported as deferred).
      const directory = process.env.OPENFARM_LIBRARY_DIR
      const blobs = directory ? await createBlobStore(directory) : undefined
      const result = await runLibraryRetention({ sql, blobs }, config)
      if (Object.values(result).some(Boolean))
        logger.info('library-retention', result)
    } catch (error) {
      logger.error('library-retention-failed', { error })
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => void run(), config.intervalMs)
  timer.unref()
  void run()
  nitro.hooks.hook('close', async () => {
    clearInterval(timer)
    await sql.end({ timeout: 3 })
  })
})
