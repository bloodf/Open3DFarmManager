import type { PrinterState } from '@open3dfarmmanager/farm-protocol'
import {
  moonrakerAuthHeaders,
  moonrakerSession,
  type validateMoonrakerInput,
} from '../config/moonraker.ts'
import {
  HISTORY_LOOKBACK_MS,
  createMoonrakerHistoryDedup,
  historyJobState,
  readMoonrakerHistory,
} from './history.ts'

type Selected = ReturnType<typeof validateMoonrakerInput>

/** Read-only `server.history.list` over Moonraker's HTTP twin, bounded in time and size. */
function historyClient(selected: Selected, signal: AbortSignal) {
  return {
    async request(method: string, params: object) {
      if (method !== 'server.history.list') throw Error('Unsupported method')
      const url = new URL('/server/history/list', selected.origin)
      for (const [name, value] of Object.entries(params))
        url.searchParams.set(name, String(value))
      const session = moonrakerSession(selected.origin, selected.limits)
      const headers = session
        ? await session.getAuthHeaders()
        : moonrakerAuthHeaders(selected.origin, selected.limits)
      const response = await fetch(url, {
        headers,
        redirect: 'error',
        credentials: 'omit',
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(Math.min(5000, selected.limits.requestTimeoutMs)),
        ]),
      })
      if (!response.ok || !response.body) throw Error('History unavailable')
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.length
          // A page is at most 50 entries; allow generous room per entry.
          if (size > Math.max(selected.limits.maxMessageBytes, 262_144))
            throw Error('History response bound')
          chunks.push(chunk.value)
        }
      } finally {
        await reader.cancel()
      }
      return JSON.parse(Buffer.concat(chunks).toString()).result
    },
  }
}

/**
 * Per-printer history import. Call `observe` for every live printer state; the
 * first one after a (re)connect starts one import. Finished jobs missing from
 * the telemetry queue are handed to `record` as past printer states.
 */
export function createMoonrakerHistoryImport(input: {
  printerKey: string
  selected: Selected
  signal: AbortSignal
  record: (state: PrinterState) => void
  onError?: (error: unknown) => void
  now?: () => number
}) {
  const now = input.now ?? Date.now
  const dedup = createMoonrakerHistoryDedup()
  const client = historyClient(input.selected, input.signal)
  let wanted = true
  let running: Promise<void> | undefined
  let previousActive = false
  async function importOnce() {
    try {
      const jobs = await readMoonrakerHistory(client, {
        sinceMs: now() - HISTORY_LOOKBACK_MS,
      })
      if (input.signal.aborted) return
      for (const job of dedup.fresh(input.printerKey, jobs))
        input.record(historyJobState(input.printerKey, job))
    } catch (error) {
      // Best effort: a refusal never disturbs live telemetry; the next reconnect retries.
      input.onError?.(error)
    }
  }
  return {
    /** A connection was lost: read history again on the next live state. */
    reconnecting() {
      wanted = true
      previousActive = false
    },
    observe(state: PrinterState['state']) {
      const active = state === 'printing' || state === 'paused'
      // A job the live path watched end is recorded live, never imported.
      if (previousActive && !active) dedup.noteLive(input.printerKey, now())
      previousActive = active
      if (!wanted || running || input.signal.aborted) return
      wanted = false
      running = importOnce().finally(() => {
        running = undefined
      })
    },
    /** Resolves when the import in flight, if any, has finished. */
    settled: () => running ?? Promise.resolve(),
  }
}
