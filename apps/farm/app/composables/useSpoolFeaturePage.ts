import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { collectPrinterPages } from '../utils/printer-pages.ts'
import { createFarmRequestGuard } from '../utils/farm-request-guard.ts'
import { useSpoolLibraryFarm } from './useSpoolLibraryFarm.ts'
import {
  EMPTY_SPOOL_FILTERS,
  extractApiError,
} from '../utils/spool-library-format.ts'
import type {
  SpoolItem,
  SpoolLibraryListResponse,
} from '../utils/spool-library-types.ts'
import type { PrinterRef } from '../utils/spool-features-types.ts'

export function spoolApi(farmId: string, path: string): string {
  return `/api/farms/${farmId}/spool-library/${path}`
}

export function featureFetch<T>(
  farmId: string,
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH'
    query?: Record<string, string | number | undefined>
    body?: Record<string, unknown>
    signal?: AbortSignal
  } = {},
): Promise<T> {
  return $fetch(spoolApi(farmId, path), {
    ...options,
    retry: 0,
    timeout: 15_000,
  }) as Promise<unknown> as Promise<T>
}

export async function fetchSpools(farmId: string, signal?: AbortSignal) {
  const response = await $fetch<SpoolLibraryListResponse<SpoolItem>>(
    spoolApi(farmId, 'spools'),
    {
      query: { sort: EMPTY_SPOOL_FILTERS.sort },
      retry: 0,
      timeout: 15_000,
      signal,
    },
  )
  return {
    items: response.items,
    canWrite: response.canWrite,
    canManage: response.canImport,
  }
}

export async function fetchPrinters(farmId: string): Promise<PrinterRef[]> {
  return collectPrinterPages((after) =>
    $fetch<{ printers: PrinterRef[]; nextAfter: string | null }>(
      `/api/farms/${farmId}/printers`,
      {
        query: { limit: 50, ...(after ? { after } : {}) },
        retry: 0,
        timeout: 15_000,
      },
    ),
  )
}

/**
 * Shared page lifecycle for the farm-linked spool pages: resolves the farm,
 * runs `load(farmId)` on mount and whenever the farm changes, and tracks
 * loading, error and status-message state.
 */
export function useSpoolFeaturePage(
  load: (
    farmId: string,
    current: () => boolean,
    signal: AbortSignal,
  ) => Promise<void>,
) {
  const farm = useSpoolLibraryFarm()
  const loading = ref(false)
  const error = ref('')
  const statusMessage = ref('')
  const actionError = ref('')
  const guard = createFarmRequestGuard(() => farm.farmId.value)
  let controller = new AbortController()

  async function reload() {
    const id = farm.farmId.value
    if (!id) return
    controller.abort()
    controller = new AbortController()
    const signal = controller.signal
    const guarded = guard.start(id)
    const current = () => !signal.aborted && guarded()
    loading.value = true
    error.value = ''
    try {
      await load(id, current, signal)
    } catch (cause) {
      if (current())
        error.value = extractApiError(
          cause,
          'Não foi possível carregar os dados. Tente novamente.',
        ).message
    } finally {
      if (current()) loading.value = false
    }
  }

  async function retry() {
    const previous = farm.farmId.value
    await farm.loadFarms()
    if (farm.farmId.value === previous) await reload()
  }

  /** Runs a mutation, reporting success in the status region or failure inline. */
  async function act(
    task: () => Promise<void>,
    success: string,
    failure: string,
  ): Promise<boolean> {
    actionError.value = ''
    try {
      await task()
      statusMessage.value = success
      return true
    } catch (cause) {
      actionError.value = extractApiError(cause, failure).message
      return false
    }
  }

  onMounted(async () => {
    await farm.loadFarms()
  })
  watch(
    farm.farmId,
    (next, prev) => {
      if (next === prev) return
      controller.abort()
      guard.invalidate()
      loading.value = false
      error.value = ''
      statusMessage.value = ''
      actionError.value = ''
      if (next) void reload()
    },
    { flush: 'sync' },
  )
  onBeforeUnmount(() => {
    guard.invalidate()
    controller.abort()
  })

  return {
    ...farm,
    loading,
    error,
    statusMessage,
    actionError,
    reload,
    retry,
    act,
  }
}
