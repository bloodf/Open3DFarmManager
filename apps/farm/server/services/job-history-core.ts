import type {
  FilamentUsage,
  TelemetryEvent,
} from '@open3dfarmmanager/farm-protocol'

export const jobHistoryCursor = /^\d{1,16}-\d{1,18}$/
export interface JobRecord {
  printerKey: string
  outcome: 'completed' | 'cancelled' | 'failed'
  filename?: string
  printDurationSeconds?: number
  totalDurationSeconds?: number
  filamentUsage?: FilamentUsage[]
  endedAt: number
}
export type JobHistoryFailure = {
  ok: false
  reason: 'invalid-input' | 'unauthorized' | 'forbidden' | 'storage-unavailable'
}
/** Every active member may read; revoked or unknown roles never do. */
export const JOB_HISTORY_READ_ROLES = [
  'owner',
  'admin',
  'operator',
  'viewer',
] as const
export const canReadJobHistory = (role: unknown): boolean =>
  JOB_HISTORY_READ_ROLES.some((allowed) => allowed === role)

/**
 * Finished jobs carried by printer-state snapshots. The Connector repeats `lastJob`
 * in every snapshot until the next print ends, so the first record per
 * printer and end time wins; storage applies the same key.
 */
export function jobsFromEvents(events: readonly TelemetryEvent[]): JobRecord[] {
  const seen = new Set<string>()
  const jobs: JobRecord[] = []
  for (const event of events) {
    if (event.kind !== 'printer-state') continue
    const last = event.state.lastJob
    if (!last) continue
    const key = `${event.state.printerKey}\u0000${last.endedAt}`
    if (seen.has(key)) continue
    seen.add(key)
    jobs.push({
      printerKey: event.state.printerKey,
      outcome: last.outcome,
      ...(last.filename ? { filename: last.filename } : {}),
      ...(last.printDuration !== undefined
        ? { printDurationSeconds: last.printDuration }
        : {}),
      ...(last.totalDuration !== undefined
        ? { totalDurationSeconds: last.totalDuration }
        : {}),
      ...(last.filamentUsage?.length
        ? { filamentUsage: last.filamentUsage }
        : last.filamentUsedMillimetres !== undefined
          ? {
              filamentUsage: [
                {
                  tool: 'unknown',
                  millimetres: last.filamentUsedMillimetres,
                },
              ],
            }
          : {}),
      endedAt: last.endedAt,
    })
  }
  return jobs
}
