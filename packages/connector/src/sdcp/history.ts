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

// Reuse short-lived sessions so repeated viewers do not crowd out control.
type HistorySession = Awaited<ReturnType<typeof openSdcpSession>>
/**
 * One connection shared by every viewer of a board. It closes only when no
 * read is using it and it is either retired (expired, failed or dropped) or
 * every viewer that used it has left.
 */
type SharedSession = {
  opening: Promise<HistorySession>
  join(viewer: AbortSignal): void
  /** Ends one read. */
  leave(): void
  /** Stops handing the connection to new reads. */
  retire(): void
}
const sessions = new Map<string, SharedSession>()
const SESSION_LIFETIME_MS = 10000
const MAX_SESSIONS = 32

function openShared(key: string, endpoint: SdcpEndpoint): SharedSession {
  const cancel = new AbortController()
  const viewers = new Map<AbortSignal, () => void>()
  let reads = 0
  let retired = false
  let session: HistorySession | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const evict = () => {
    if (sessions.get(key) === shared) sessions.delete(key)
  }
  const closeIfUnused = () => {
    if (reads > 0 || (!retired && viewers.size > 0)) return
    evict()
    clearTimeout(timer)
    for (const [viewer, left] of viewers)
      viewer.removeEventListener('abort', left)
    viewers.clear()
    cancel.abort()
    session?.close()
  }
  const retire = () => {
    retired = true
    evict()
    closeIfUnused()
  }
  const open = async () => {
    const opened = await openSdcpSession(endpoint, { signal: cancel.signal })
    if (!opened.connected || cancel.signal.aborted) {
      opened.close()
      throw new Error('SDCP history session closed')
    }
    session = opened
    timer = setTimeout(retire, SESSION_LIFETIME_MS)
    timer.unref()
    opened.onClose(retire)
    return opened
  }
  const shared: SharedSession = {
    opening: open(),
    join(viewer) {
      reads++
      if (viewers.has(viewer)) return
      const left = () => {
        viewers.delete(viewer)
        closeIfUnused()
      }
      viewers.set(viewer, left)
      viewer.addEventListener('abort', left, { once: true })
    },
    leave() {
      reads--
      closeIfUnused()
    },
    retire,
  }
  // Every viewer may leave before the connection opens.
  shared.opening.catch(retire)
  return shared
}

function historySession(endpoint: SdcpEndpoint) {
  const key = JSON.stringify([
    endpoint.host,
    endpoint.mainboardId,
    endpoint.model,
    endpoint.discoveryPort ?? 3000,
    endpoint.websocketPort ?? 3030,
  ])
  let shared = sessions.get(key)
  if (shared) return shared
  if (sessions.size >= MAX_SESSIONS)
    throw new Error('Too many SDCP history sessions')
  shared = openShared(key, endpoint)
  sessions.set(key, shared)
  return shared
}

/** Waits for the shared connection no longer than this read may. */
function until<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    if (signal.aborted) return abort()
    signal.addEventListener('abort', abort, { once: true })
    pending
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort))
  })
}

export async function readSdcpHistory(
  endpoint: SdcpEndpoint,
  signal: AbortSignal,
): Promise<SdcpHistoryJob[]> {
  // Refuses a model without documented history before any connection.
  const list = buildSdcpHistoryCommand(endpoint.model)
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(8000)])
  signal.throwIfAborted()
  const shared = historySession(endpoint)
  shared.join(signal)
  try {
    const session = await until(shared.opening, bounded)
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
  } catch (error) {
    // A viewer leaving says nothing about the connection. Any other failure
    // retires it: new reads reconnect, reads in flight keep using it.
    if (!signal.aborted) shared.retire()
    throw error
  } finally {
    shared.leave()
  }
}
