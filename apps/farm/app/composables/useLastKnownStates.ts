import {
  computed,
  getCurrentInstance,
  onBeforeUnmount,
  shallowRef,
  watch,
} from 'vue'
import {
  lastKnownStatesFailureReason,
  parseLastKnownStates,
  type LastKnownState,
  type LastKnownStatesState,
} from '../utils/last-known-states.ts'

type Read = (path: string, signal: AbortSignal) => Promise<unknown>

type Dependencies = {
  read: Read
  changed: (state: LastKnownStatesState) => void
}

/**
 * Reads the last known states of a farm.
 *
 * The route is only consulted while no live feed is available. When P2P
 * connects, the stored states stop being read: the live rows own the printers
 * from that moment on, so a printer never shows two cards.
 */
export function createLastKnownStates(deps: Dependencies) {
  let state: LastKnownStatesState = { kind: 'idle' }
  let controller: AbortController | undefined
  let disposed = false
  let farmId: string | undefined
  const publish = (next: LastKnownStatesState) => {
    state = next
    deps.changed(next)
  }
  function retire() {
    const previous = controller
    controller = undefined
    previous?.abort()
  }
  async function load(nextFarmId: string | undefined) {
    if (disposed) return
    retire()
    farmId = nextFarmId
    if (!nextFarmId) {
      publish({ kind: 'idle' })
      return
    }
    const run = new AbortController()
    controller = run
    publish({ kind: 'loading' })
    try {
      const body = await deps.read(
        `/api/farms/${nextFarmId}/printer-states`,
        run.signal,
      )
      if (disposed || run.signal.aborted || farmId !== nextFarmId) return
      const parsed = parseLastKnownStates(body)
      if (!parsed.ok) {
        publish({ kind: 'unavailable', reason: parsed.reason })
        return
      }
      publish({ kind: 'ready', states: parsed.states })
    } catch (error) {
      if (disposed || run.signal.aborted || farmId !== nextFarmId) return
      const status =
        typeof error === 'object' &&
        error !== null &&
        'statusCode' in error &&
        typeof error.statusCode === 'number'
          ? error.statusCode
          : undefined
      publish({
        kind: 'unavailable',
        reason: lastKnownStatesFailureReason(status),
      })
    }
  }
  return {
    load,
    dispose: () => {
      disposed = true
      retire()
      publish({ kind: 'idle' })
    },
  }
}

/**
 * Vue wrapper around `createLastKnownStates`.
 *
 * The stored states are read only while the live feed is unavailable. Once a
 * live feed authenticates, the stored states are released: the live rows
 * replace them without duplicating a card.
 */
export function useLastKnownStates(options?: {
  farmId?: () => string | undefined
  live?: () => boolean
  read?: Read
}) {
  const state = shallowRef<LastKnownStatesState>({ kind: 'idle' })
  const farmId = options?.farmId ?? (() => undefined)
  const live = options?.live ?? (() => false)
  const read =
    options?.read ??
    ((path: string, signal: AbortSignal) =>
      $fetch<unknown>(path, {
        signal,
        retry: 0,
        timeout: 10_000,
        cache: 'no-store',
      }))
  const controller = createLastKnownStates({
    read,
    changed: (next) => {
      state.value = next
    },
  })
  watch(
    [farmId, live],
    ([currentFarmId, isLive]) => {
      // A live feed owns the printers: the stored states are not read and the
      // previous answer is released, so no card survives the switch.
      if (isLive || !currentFarmId) {
        controller.load(undefined)
        return
      }
      void controller.load(currentFarmId)
    },
    { immediate: true },
  )
  // The unmount hook is registered only inside a component instance; outside
  // one the caller owns the disposal.
  if (getCurrentInstance()) onBeforeUnmount(() => controller.dispose())
  const states = computed<readonly LastKnownState[]>(() =>
    state.value.kind === 'ready' ? state.value.states : [],
  )
  return { state, states, load: controller.load, dispose: controller.dispose }
}
