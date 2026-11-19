import postgres from 'postgres'
import { createError, useRuntimeConfig } from 'nuxt/server'
import { createLogger } from '@open3dfarmmanager/shared'
import {
  PostgresFarmNetworkReader,
  type FarmNetworkReader,
} from '../../storage/postgres-farm-network.ts'

const log = createLogger('farm-server')

let instance: FarmNetworkReader | undefined
let closePool: (() => Promise<void>) | undefined
/** Shares the `printerStates` switch and its read-only `farm_printer_state_reader` login. */
export function farmNetworkRuntime(): FarmNetworkReader {
  const config: unknown = useRuntimeConfig()['printerStates']
  if (
    typeof config !== 'object' ||
    config === null ||
    !('enabled' in config) ||
    config.enabled !== true
  )
    throw createError({ status: 404, message: 'Rede da farm indisponível.' })
  if (instance) return instance
  try {
    if (!('databaseUrl' in config) || typeof config.databaseUrl !== 'string')
      throw new Error()
    const url = new URL(config.databaseUrl)
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error()
    const sql = postgres(url.toString(), {
      max: 3,
      connect_timeout: 3,
      idle_timeout: 20,
      connection: { statement_timeout: 2000, lock_timeout: 1000 },
    })
    closePool = () => sql.end({ timeout: 3 })
    instance = new PostgresFarmNetworkReader(sql)
    return instance
  } catch {
    log.error('farm-network runtime unavailable')
    throw createError({
      status: 503,
      message: 'Rede da farm indisponível. Tente novamente.',
    })
  }
}
export async function closeFarmNetworkRuntime(): Promise<void> {
  await closePool?.()
  instance = undefined
  closePool = undefined
}
