import { onScopeDispose, ref, watch } from 'vue'
import type {
  SpoolItem,
  SpoolLibraryListResponse,
} from '../utils/spool-library-types'
import type { JobHistoryItem } from '../utils/job-history-view'

/** Independent read-only indexes; discard every response when its farm changes. */
export function useShellRecords(
  farmId: () => string | undefined,
  paletteOpen: () => boolean,
  query: () => string = () => '',
) {
  const spools = ref<SpoolItem[]>([])
  const spoolTruncated = ref(false)
  const spoolState = ref<'idle' | 'loading' | 'ready' | 'unavailable'>('idle')
  const latestJob = ref<JobHistoryItem | null>(null)
  const eventState = ref<'idle' | 'loading' | 'ready' | 'unavailable'>('idle')
  let spoolRequest: AbortController | undefined
  let eventRequest: AbortController | undefined
  watch(
    [farmId, paletteOpen, query],
    ([farm, open, term]) => {
      spoolRequest?.abort()
      spools.value = []
      spoolTruncated.value = false
      spoolState.value = 'idle'
      if (!farm || !open) return
      const request = (spoolRequest = new AbortController())
      spoolState.value = 'loading'
      void $fetch<SpoolLibraryListResponse<SpoolItem>>(
        `/api/farms/${encodeURIComponent(farm)}/spool-library/spools`,
        {
          query: { limit: 100, ...(term.trim() ? { q: term.trim() } : {}) },
          signal: request.signal,
          retry: 0,
          timeout: 10_000,
        },
      )
        .then((page) => {
          if (request.signal.aborted) return
          spools.value = page.items.filter((spool) => !spool.archived)
          spoolTruncated.value = page.total > page.items.length
          spoolState.value = 'ready'
        })
        .catch(() => {
          if (!request.signal.aborted) spoolState.value = 'unavailable'
        })
    },
    { immediate: true },
  )
  let eventTimer: ReturnType<typeof setInterval> | undefined
  function loadEvent(farm: string) {
    eventRequest?.abort()
    const request = (eventRequest = new AbortController())
    eventState.value = 'loading'
    void $fetch<{ jobs: JobHistoryItem[] }>('/api/job-history', {
      query: { farmId: farm, limit: 1 },
      signal: request.signal,
      retry: 0,
      timeout: 10_000,
    })
      .then((page) => {
        if (request.signal.aborted) return
        latestJob.value = page.jobs[0] ?? null
        eventState.value = 'ready'
      })
      .catch(() => {
        if (!request.signal.aborted) {
          latestJob.value = null
          eventState.value = 'unavailable'
        }
      })
  }
  watch(
    farmId,
    (farm) => {
      eventRequest?.abort()
      if (eventTimer) clearInterval(eventTimer)
      latestJob.value = null
      eventState.value = 'idle'
      if (!farm) return
      loadEvent(farm)
      eventTimer = setInterval(() => {
        if (document.visibilityState !== 'hidden') loadEvent(farm)
      }, 30_000)
    },
    { immediate: true },
  )
  onScopeDispose(() => {
    spoolRequest?.abort()
    eventRequest?.abort()
    if (eventTimer) clearInterval(eventTimer)
  })
  return { spools, spoolState, spoolTruncated, latestJob, eventState }
}
