import type { Sql } from 'postgres'

export type TelemetryPruneConfig = Readonly<{
  telemetryRetentionDays: number
  jobHistoryRetentionDays: number
  batchSize: number
}>

export type TelemetryPruneRuntimeConfig = TelemetryPruneConfig &
  Readonly<{
    databaseUrl: string
    intervalMs: number
  }>

export function parseTelemetryPruneConfig(
  value: unknown,
): TelemetryPruneRuntimeConfig | undefined {
  if (!value || typeof value !== 'object') return
  const input = value as Record<string, unknown>
  if (input.enabled !== true) return
  const databaseUrl = input.databaseUrl
  const intervalMs = input.intervalMs ?? 3600000
  const telemetryRetentionDays = input.telemetryRetentionDays ?? 30
  const jobHistoryRetentionDays = input.jobHistoryRetentionDays ?? 365
  const batchSize = input.batchSize ?? 500
  if (typeof databaseUrl !== 'string' || !databaseUrl)
    throw new Error('Invalid telemetry prune database URL')
  const url = new URL(databaseUrl)
  if (!['postgres:', 'postgresql:'].includes(url.protocol))
    throw new Error('Invalid telemetry prune database URL')
  if (
    !Number.isInteger(intervalMs) ||
    Number(intervalMs) < 60000 ||
    Number(intervalMs) > 86400000
  )
    throw new Error('Invalid telemetry prune interval')
  if (
    ![telemetryRetentionDays, jobHistoryRetentionDays].every(
      (days) =>
        Number.isInteger(days) && Number(days) >= 1 && Number(days) <= 3650,
    )
  )
    throw new Error('Invalid telemetry prune retention')
  if (
    !Number.isInteger(batchSize) ||
    Number(batchSize) < 1 ||
    Number(batchSize) > 10000
  )
    throw new Error('Invalid telemetry prune batch size')
  return {
    databaseUrl,
    intervalMs: Number(intervalMs),
    telemetryRetentionDays: Number(telemetryRetentionDays),
    jobHistoryRetentionDays: Number(jobHistoryRetentionDays),
    batchSize: Number(batchSize),
  }
}

export async function pruneTelemetry(
  sql: Sql,
  config: TelemetryPruneConfig,
): Promise<Readonly<{ telemetryDeleted: number; jobsDeleted: number }>> {
  return sql.begin(async (tx) => {
    await tx`SET LOCAL statement_timeout = '5000ms'`
    await tx`SET LOCAL lock_timeout = '1000ms'`
    const [result] = await tx`
      SELECT telemetry_deleted AS "telemetryDeleted", jobs_deleted AS "jobsDeleted"
      FROM farm.prune_telemetry(
        ${config.telemetryRetentionDays},
        ${config.jobHistoryRetentionDays},
        ${config.batchSize}
      )
    `
    return {
      telemetryDeleted: Number(result?.telemetryDeleted ?? 0),
      jobsDeleted: Number(result?.jobsDeleted ?? 0),
    }
  })
}
