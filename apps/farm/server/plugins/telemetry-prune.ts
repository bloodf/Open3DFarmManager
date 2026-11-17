import postgres from 'postgres'
import { createLogger } from '@open3dfarmmanager/shared'
import { useRuntimeConfig } from 'nuxt/server'
import {
  parseTelemetryPruneConfig,
  pruneTelemetry,
} from '../services/prune-telemetry.ts'

const logger = createLogger('farm-server')

export default defineNitroPlugin((nitro) => {
  if (import.meta.prerender) return
  const config = parseTelemetryPruneConfig(
    Reflect.get(useRuntimeConfig(), 'telemetryPrune'),
  )
  if (!config) return
  const sql = postgres(config.databaseUrl, {
    max: 1,
    connect_timeout: 3,
    idle_timeout: 20,
    connection: {
      statement_timeout: 5000,
      lock_timeout: 1000,
      options: '-c role=farm_telemetry_pruner',
      search_path: 'pg_catalog',
    },
  })
  let running = false
  const prune = async () => {
    if (running) return
    running = true
    try {
      const result = await pruneTelemetry(sql, config)
      if (result.telemetryDeleted || result.jobsDeleted)
        logger.info('telemetry-pruned', result)
    } catch (error) {
      logger.error('telemetry-prune-failed', { error })
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => void prune(), config.intervalMs)
  timer.unref()
  void prune()
  nitro.hooks.hook('close', async () => {
    clearInterval(timer)
    await sql.end({ timeout: 3 })
  })
})
