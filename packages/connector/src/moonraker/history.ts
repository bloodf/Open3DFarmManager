import type { PrinterState } from '@open3dfarmmanager/farm-protocol'

/** One finished print read from Moonraker's own history. */
export type MoonrakerHistoryJob = Readonly<{
  outcome: 'completed' | 'cancelled' | 'failed'
  filename?: string
  /** Epoch milliseconds. */
  startedAt?: number
  /** Epoch milliseconds; with the printer key, the deduplication key. */
  endedAt: number
  printDuration?: number
  totalDuration?: number
  /** Millimetres of filament Moonraker reports as used. */
  filamentUsedMm?: number
}>

export const HISTORY_PAGE_SIZE = 50
export const HISTORY_MAX_PAGES = 4
/** Jobs that ended this long before the import are not read. */
export const HISTORY_LOOKBACK_MS = 30 * 24 * 3_600_000
/** A live-recorded end is observed late; a history end this close is the same job. */
export const HISTORY_LIVE_TOLERANCE_MS = 120_000

const OUTCOMES: Readonly<Record<string, MoonrakerHistoryJob['outcome']>> = {
  completed: 'completed',
  cancelled: 'cancelled',
  error: 'failed',
  interrupted: 'failed',
  klippy_shutdown: 'failed',
  klippy_disconnect: 'failed',
  server_exit: 'failed',
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
const nonNegative = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined

/** Valid finished jobs of one `server.history.list` result; malformed or unfinished entries are skipped. */
export function parseMoonrakerHistoryPage(result: unknown): {
  jobs: MoonrakerHistoryJob[]
  /** Raw entries on the page, used to decide whether another page exists. */
  entries: number
} {
  const list = record(result)?.jobs
  if (!Array.isArray(list)) throw Error('Invalid history response')
  const jobs: MoonrakerHistoryJob[] = []
  for (const raw of list.slice(0, HISTORY_PAGE_SIZE)) {
    const item = record(raw)
    const outcome =
      typeof item?.status === 'string' && Object.hasOwn(OUTCOMES, item.status)
        ? OUTCOMES[item.status]
        : undefined
    const end = nonNegative(item?.end_time)
    if (!item || !outcome || end === undefined || end === 0) continue
    const start = nonNegative(item.start_time)
    const filename =
      typeof item.filename === 'string'
        ? item.filename
            .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
            .slice(0, 255)
        : ''
    const printDuration = nonNegative(item.print_duration)
    const totalDuration = nonNegative(item.total_duration)
    const filament = nonNegative(item.filament_used)
    jobs.push({
      outcome,
      ...(filename ? { filename } : {}),
      ...(start ? { startedAt: Math.round(start * 1000) } : {}),
      endedAt: Math.round(end * 1000),
      ...(printDuration === undefined ? {} : { printDuration }),
      ...(totalDuration === undefined ? {} : { totalDuration }),
      ...(filament === undefined ? {} : { filamentUsedMm: filament }),
    })
  }
  return { jobs, entries: list.length }
}

/**
 * Reads newest-first history pages: at most HISTORY_MAX_PAGES of
 * HISTORY_PAGE_SIZE entries, none ended before `sinceMs`.
 */
export async function readMoonrakerHistory(
  client: { request(method: string, params: object): Promise<unknown> },
  input: { sinceMs: number },
): Promise<MoonrakerHistoryJob[]> {
  const jobs: MoonrakerHistoryJob[] = []
  for (let page = 0; page < HISTORY_MAX_PAGES; page++) {
    const { jobs: found, entries } = parseMoonrakerHistoryPage(
      await client.request('server.history.list', {
        limit: HISTORY_PAGE_SIZE,
        start: page * HISTORY_PAGE_SIZE,
        since: Math.floor(input.sinceMs / 1000),
        order: 'desc',
      }),
    )
    jobs.push(...found.filter((job) => job.endedAt >= input.sinceMs))
    if (entries < HISTORY_PAGE_SIZE) break
  }
  return jobs
}

/**
 * Telemetry projection of a history job: a past printer-state whose
 * `lastJob` is what job history stores (storage keeps the first record per
 * printer and end time).
 */
export function historyJobState(
  printerKey: string,
  job: MoonrakerHistoryJob,
): PrinterState {
  return {
    printerKey,
    state: 'idle',
    progress: job.outcome === 'completed' ? 1 : 0,
    lastJob: {
      outcome: job.outcome,
      ...(job.filename ? { filename: job.filename } : {}),
      ...(job.printDuration === undefined
        ? {}
        : { printDuration: job.printDuration }),
      ...(job.totalDuration === undefined
        ? {}
        : { totalDuration: job.totalDuration }),
      ...(job.filamentUsedMm === undefined
        ? {}
        : { filamentUsedMillimetres: job.filamentUsedMm }),
      endedAt: job.endedAt,
    },
    observedAt: job.endedAt,
  }
}

/**
 * Remembers which ends are already recorded, live or imported, so a re-import
 * after a reconnect adds nothing and a job recorded live is never repeated.
 */
export function createMoonrakerHistoryDedup() {
  const live = new Map<string, number[]>()
  const imported = new Set<string>()
  return {
    /** A job recorded by the live path, with its observed (late) end time. */
    noteLive(printerKey: string, endedAt: number) {
      const list = live.get(printerKey) ?? []
      list.push(endedAt)
      // Bound memory: only the most recent live ends can match a history job.
      if (list.length > HISTORY_PAGE_SIZE) list.shift()
      live.set(printerKey, list)
    },
    /** The jobs not yet recorded, oldest first; marks them recorded. */
    fresh(
      printerKey: string,
      jobs: readonly MoonrakerHistoryJob[],
    ): MoonrakerHistoryJob[] {
      const out: MoonrakerHistoryJob[] = []
      for (const job of [...jobs].sort((a, b) => a.endedAt - b.endedAt)) {
        const key = `${printerKey}\u0000${job.endedAt}`
        if (imported.has(key)) continue
        imported.add(key)
        // Live ends are seen late, so they match within a tolerance;
        // imported ends are exact, so quick back-to-back jobs stay distinct.
        const seenLive = live
          .get(printerKey)
          ?.some(
            (end) => Math.abs(end - job.endedAt) <= HISTORY_LIVE_TOLERANCE_MS,
          )
        if (!seenLive) out.push(job)
      }
      return out
    },
  }
}
