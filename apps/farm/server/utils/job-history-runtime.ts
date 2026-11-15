import postgres from 'postgres'
import { createError, useRuntimeConfig } from 'nuxt/server'
import {
  PostgresJobHistory,
  type JobHistoryListInput,
  type JobHistoryListResult,
} from '../storage/job-history-store.ts'

export interface JobHistoryReader {
  list(input: JobHistoryListInput): Promise<JobHistoryListResult>
}
let instance: PostgresJobHistory | undefined
let closePool: (() => Promise<void>) | undefined
/** Disabled unless `jobHistory.enabled` and a `farm_job_history_reader` login URL are configured. */
export function jobHistoryRuntime(): JobHistoryReader {
  const config: unknown = useRuntimeConfig()['jobHistory']
  if (
    typeof config !== 'object' ||
    config === null ||
    !('enabled' in config) ||
    config.enabled !== true
  )
    throw createError({ status: 404, message: 'Histórico indisponível.' })
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
    instance = new PostgresJobHistory(sql)
    return instance
  } catch {
    throw createError({
      status: 503,
      message: 'Histórico indisponível. Tente novamente.',
    })
  }
}
export async function closeJobHistoryRuntime(): Promise<void> {
  await closePool?.()
  instance = undefined
  closePool = undefined
}
