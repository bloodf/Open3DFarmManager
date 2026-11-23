import { count, fields, list, string, type Fields } from './detail-normalize.ts'

/** Entries per `server.history.list` request. */
export const HISTORY_PAGE = 64
/** Hard ceiling on jobs returned to the browser; matches the protocol cap. */
export const HISTORY_MAX_ITEMS = 256

type Request = (method: string, params?: Fields) => Promise<unknown>

const text = (value: unknown, max: number) =>
  string(value, max).replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
const ms = (seconds: unknown) => count(Number(seconds) * 1000)

/**
 * Pages `server.history.list` newest first until the cap, the end of the
 * list, or an abort. Read-only; never retries a failed page.
 */
async function historyJobs(request: Request, signal: AbortSignal) {
  const jobs: Fields[] = []
  while (jobs.length < HISTORY_MAX_ITEMS) {
    signal.throwIfAborted()
    const page = fields(
      await request('server.history.list', {
        start: jobs.length,
        limit: HISTORY_PAGE,
        order: 'desc',
      }),
    )
    const batch = list(page.jobs).slice(0, HISTORY_PAGE).map(fields)
    jobs.push(...batch)
    if (batch.length < HISTORY_PAGE || jobs.length >= Number(page.count)) break
  }
  return jobs.slice(0, HISTORY_MAX_ITEMS)
}

/** Detail `history` query result: bounded, validated, newest first. */
export async function readDetailHistory(request: Request, signal: AbortSignal) {
  return (await historyJobs(request, signal))
    .map((job) => ({
      id: text(job.job_id, 128),
      file: text(job.filename, 512),
      state: text(job.status, 128),
      startedAtMs: ms(job.start_time),
      durationSeconds: count(job.total_duration),
    }))
    .filter((job) => job.id && job.file && job.state)
}

/** Detail `totals` query result from `server.history.totals`. */
export async function readDetailTotals(request: Request) {
  const totals = fields(
    fields(await request('server.history.totals')).job_totals,
  )
  const longest = Number(totals.longest_job)
  return {
    jobs: count(totals.total_jobs),
    printSeconds: count(totals.total_print_time),
    filamentMm: count(totals.total_filament_used),
    ...(Number.isFinite(longest) && longest > 0
      ? { longestJobSeconds: longest }
      : {}),
  }
}
