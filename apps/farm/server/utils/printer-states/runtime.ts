import postgres from 'postgres'
import { createError, useRuntimeConfig } from 'nuxt/server'
import { createLogger } from '@open3dfarmmanager/shared'
import {
  PostgresPrinterStateReader,
  type PrinterStateListInput,
} from '../../storage/postgres-printer-state-reader.ts'
import type {
  PrinterStateRow,
  PrinterStatesFailure,
} from '../../services/printer-states-core.ts'

const log = createLogger('farm-server')

export interface PrinterStateReader {
  list(
    input: PrinterStateListInput,
  ): Promise<
    | { ok: true; states: PrinterStateRow[] }
    | { ok: false; reason: PrinterStatesFailure['reason'] }
  >
}
let instance: PrinterStateReader | undefined
let closePool: (() => Promise<void>) | undefined
/**
 * Disabled unless `printerStates.enabled` and a `farm_printer_state_reader`
 * login URL are configured. The route answers 404 while the runtime is off.
 */
export function printerStatesRuntime(): PrinterStateReader {
  const config: unknown = useRuntimeConfig()['printerStates']
  if (
    typeof config !== 'object' ||
    config === null ||
    !('enabled' in config) ||
    config.enabled !== true
  )
    throw createError({
      status: 404,
      message: 'Estados das impressoras indisponível.',
    })
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
    instance = new PostgresPrinterStateReader(sql)
    return instance
  } catch {
    log.error('printer-states runtime unavailable')
    throw createError({
      status: 503,
      message: 'Estados das impressoras indisponíveis. Tente novamente.',
    })
  }
}
export async function closePrinterStatesRuntime(): Promise<void> {
  await closePool?.()
  instance = undefined
  closePool = undefined
}
