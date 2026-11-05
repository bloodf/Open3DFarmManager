import { computed, onBeforeUnmount, onMounted, shallowRef } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { createFarmView, type FarmViewState } from '../utils/farm-view.ts'
import { listDeviceKeys } from '../utils/device-key.ts'

export function useFarmView() {
  // Per component instance, client-only. Never serialize private scope into a Nuxt payload.
  const state = shallowRef<FarmViewState>({ kind: 'loading' })
  const now = shallowRef({ wall: 0, mono: 0 })
  const clock = () => ({ wall: Date.now(), mono: performance.now() })
  const view = createFarmView({
    read: (path, signal, query) =>
      $fetch<unknown>(path, {
        signal,
        query,
        retry: 0,
        timeout: 10_000,
        cache: 'no-store',
      }),
    listKeys: listDeviceKeys,
    clock,
    changed: (next) => {
      state.value = next
    },
    // A genuine admitted status producer is required before wiring a feed here.
  })
  let timer: ReturnType<typeof setInterval> | undefined
  const revalidate = () => {
    view.invalidate()
    if (document.visibilityState !== 'hidden') void view.discover()
  }
  const hide = () => view.invalidate()
  onMounted(() => {
    now.value = clock()
    void view.discover()
    timer = setInterval(() => {
      now.value = clock()
      view.tick()
    }, 1000)
    window.addEventListener('focus', revalidate)
    window.addEventListener('pageshow', revalidate)
    window.addEventListener('pagehide', hide)
    window.addEventListener('open3dfarmmanager:auth-invalidated', revalidate)
    document.addEventListener('visibilitychange', revalidate)
  })
  onBeforeRouteLeave(hide)
  onBeforeUnmount(() => {
    view.dispose()
    clearInterval(timer)
    window.removeEventListener('focus', revalidate)
    window.removeEventListener('pageshow', revalidate)
    window.removeEventListener('pagehide', hide)
    window.removeEventListener('open3dfarmmanager:auth-invalidated', revalidate)
    document.removeEventListener('visibilitychange', revalidate)
  })
  return {
    state,
    now,
    ready: computed(() => (state.value.kind === 'ready' ? state.value : null)),
    ...view,
  }
}
