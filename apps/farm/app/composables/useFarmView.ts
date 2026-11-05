import { computed, onBeforeUnmount, onMounted, shallowRef } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import {
  createFarmView,
  type FarmStatusFeed,
  type FarmViewState,
} from '../utils/farm-view.ts'
import { listDeviceKeys } from '../utils/device-key.ts'
import { createAuthenticatedFarmStatusFeed } from '../utils/webrtc/farm-status-feed.ts'
import { createFarmStatusKeyResolver } from '../utils/webrtc/farm-status-key-resolver.ts'

export function useFarmView() {
  // Per component instance, client-only. Never serialize private scope into a Nuxt payload.
  const state = shallowRef<FarmViewState>({ kind: 'loading' })
  const now = shallowRef({ wall: 0, mono: 0 })
  const clock = () => ({ wall: Date.now(), mono: performance.now() })
  let feed: FarmStatusFeed | undefined
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
    feed: {
      open(input) {
        if (!feed) {
          input.onHealth({ kind: 'closed', reason: 'rejected' })
          return { close() {} }
        }
        return feed.open(input)
      },
    },
  })
  let timer: ReturnType<typeof setInterval> | undefined
  const revalidate = () => {
    view.invalidate()
    if (document.visibilityState !== 'hidden') void view.discover()
  }
  const hide = () => view.invalidate()
  onMounted(() => {
    feed = createAuthenticatedFarmStatusFeed({
      resolveKey: createFarmStatusKeyResolver({
        isCurrent(scope, keyId) {
          const current = state.value
          return (
            current.kind === 'ready' &&
            current.accountId === scope.accountId &&
            current.scope?.accountId === scope.accountId &&
            current.scope.farmId === scope.farmId &&
            current.scope.viewEpoch === scope.viewEpoch &&
            current.keys.kind === 'available' &&
            current.keys.selected === keyId
          )
        },
      }),
    })
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
    feed = undefined
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
