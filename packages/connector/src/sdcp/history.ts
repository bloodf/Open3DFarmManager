/**
 * Read-only print history of a resin board:
 * cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0 @ f977215, Cmd 320
 * (`HistoryData`, task ids) and Cmd 321 (`{Id}` to `HistoryDetailList`:
 * `TaskName`, `BeginTime` and `EndTime` in seconds, `TaskStatus` 0 other,
 * 1 completed, 2 exceptional, 3 stopped). alfiedennen/sdcp-saturn-4-ultra
 * @ d253519 README.md reports both working on firmware V1.5.6.
 */
import { buildSdcpHistoryCommand, isSdcpTaskId } from './commands.ts'
import { openSdcpSession, type SdcpEndpoint } from './session.ts'

export type SdcpHistoryJob = {
  id: string
  file: string
  state: 'completed' | 'cancelled' | 'error'
  startedAtMs: number
  durationSeconds: number
}

/** The spec does not state the list's order; only the first ids are read. */
const MAX_TASKS = 48
const BATCH = 16
// Status 0 ("other") names no outcome, so such a task is not listed.
const OUTCOMES = new Map([
  [1, 'completed'],
  [2, 'error'],
  [3, 'cancelled'],
] as const)

const seconds = (value: unknown) =>
  Number.isSafeInteger(value) && Number(value) > 0 && Number(value) < 1e11
    ? Number(value)
    : undefined

export function decodeSdcpHistoryTask(
  value: unknown,
): SdcpHistoryJob | undefined {
  if (!value || typeof value !== 'object') return
  const task = value as Record<string, unknown>
  const state = OUTCOMES.get(task.TaskStatus as 1 | 2 | 3)
  const begin = seconds(task.BeginTime)
  const end = seconds(task.EndTime)
  const file =
    typeof task.TaskName === 'string'
      ? task.TaskName.replace(/^\/local\//, '')
      : ''
  if (
    !isSdcpTaskId(task.TaskId) ||
    !state ||
    begin === undefined ||
    end === undefined ||
    end < begin ||
    !file ||
    file.length > 512 ||
    /[\x00-\x1f\x7f\uD800-\uDFFF]/u.test(file)
  )
    return
  return {
    id: task.TaskId,
    file,
    state,
    startedAtMs: begin * 1000,
    durationSeconds: end - begin,
  }
}

function accepted(reply: Record<string, unknown>) {
  if (reply.Ack !== 0) throw new Error('SDCP history refused')
  return reply
}

export async function readSdcpHistory(
  endpoint: SdcpEndpoint,
  signal: AbortSignal,
): Promise<SdcpHistoryJob[]> {
  // Refuses a model without documented history before any connection.
  const list = buildSdcpHistoryCommand(endpoint.model)
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(8000)])
  const session = await openSdcpSession(endpoint, { signal: bounded })
  try {
    const reply = accepted(await session.request(list, bounded))
    if (!Array.isArray(reply.HistoryData))
      throw new Error('SDCP history malformed')
    const ids = [...new Set(reply.HistoryData.filter(isSdcpTaskId))].slice(
      0,
      MAX_TASKS,
    )
    const jobs: SdcpHistoryJob[] = []
    for (let start = 0; start < ids.length; start += BATCH) {
      const requested = new Set(ids.slice(start, start + BATCH))
      const detail = accepted(
        await session.request(
          buildSdcpHistoryCommand(endpoint.model, [...requested]),
          bounded,
        ),
      )
      if (!Array.isArray(detail.HistoryDetailList))
        throw new Error('SDCP history malformed')
      for (const task of detail.HistoryDetailList.slice(0, BATCH)) {
        const job = decodeSdcpHistoryTask(task)
        if (job && requested.delete(job.id)) jobs.push(job)
      }
    }
    return jobs.sort((a, b) => b.startedAtMs - a.startedAtMs)
  } finally {
    session.close()
  }
}
