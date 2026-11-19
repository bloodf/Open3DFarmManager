import {
  getCurrentInstance,
  onBeforeUnmount,
  ref,
  shallowRef,
  watch,
} from 'vue'
import {
  parseStatusSummary,
  statusSummaryPath,
  type StatusSummaryView,
} from '../utils/status-summary.ts'

/** The wall also has the live feed, so its summary polls less often than the TV. */
export const WALL_SUMMARY_POLL_MS = 10_000

type Read = (path: string, signal: AbortSignal) => Promise<unknown>

/**
 * Polls `GET /api/farms/{farmId}/status-summary` for the wall summary.
 *
 * The route answers every printer of the farm in one bounded request, so the
 * counts cover the whole farm and not just the page of assignments the wall
 * lists. `cache: 'no-cache'` makes the browser revalidate with the route's
 * ETag: an unchanged farm costs a 304 and no body.
 *
 * A failed poll keeps the previous summary and flags it: stale counts must
 * never look current.
 */
export function useStatusSummary(options: {
  farmId: () => string | undefined
  intervalMs?: number
  read?: Read
}) {
  const summary = shallowRef<StatusSummaryView | null>(null)
  const fetchedAt = ref<number | null>(null)
  const failed = ref(false)
  const read: Read =
    options.read ??
    ((path, signal) =>
      $fetch<unknown>(path, {
        signal,
        retry: 0,
        timeout: 10_000,
        cache: 'no-cache',
      }))
  let controller: AbortController | undefined
  let timer: ReturnType<typeof setInterval> | undefined

  async function poll(farmId: string) {
    controller?.abort()
    const run = (controller = new AbortController())
    try {
      const parsed = parseStatusSummary(
        await read(statusSummaryPath(farmId), run.signal),
      )
      if (run.signal.aborted) return
      if (!parsed.ok) throw new Error('invalid-response')
      summary.value = parsed.summary
      fetchedAt.value = Date.now()
      failed.value = false
    } catch {
      if (run.signal.aborted) return
      failed.value = true
    }
  }

  function stop() {
    controller?.abort()
    controller = undefined
    if (timer) clearInterval(timer)
    timer = undefined
  }

  watch(
    options.farmId,
    (farmId) => {
      stop()
      summary.value = null
      fetchedAt.value = null
      failed.value = false
      if (!farmId) return
      void poll(farmId)
      timer = setInterval(() => {
        if (document.visibilityState !== 'hidden') void poll(farmId)
      }, options.intervalMs ?? WALL_SUMMARY_POLL_MS)
    },
    { immediate: true },
  )
  if (getCurrentInstance()) onBeforeUnmount(stop)
  return { summary, fetchedAt, failed, stop }
}
