// SPDX-License-Identifier: MIT
import { computed, shallowRef } from 'vue'
import { useFarmView as useRealFarmView } from '../../apps/farm/app/composables/useFarmView'
import type { FarmViewState } from '../../apps/farm/app/utils/farm-view.ts'

type Ready = Extract<FarmViewState, { kind: 'ready' }>
declare const window: Window & {
  __farmInventory?: Ready
  __disconnectFarmFeed: () => void
}

/** Use the real farm view except in the test that controls feed loss. */
export function useFarmView(...args: Parameters<typeof useRealFarmView>) {
  if (!window.__farmInventory) return useRealFarmView(...args)
  const ready = shallowRef(window.__farmInventory)
  const now = shallowRef({ mono: performance.now(), wall: Date.now() })
  window.__disconnectFarmFeed = () => {
    ready.value = {
      ...ready.value,
      rows: ready.value.rows.map((row) => ({ ...row, connection: 'closed' })),
    }
  }
  return {
    state: computed(() => ready.value),
    ready,
    now,
    discover() {},
    selectFarm() {},
    selectKey() {},
    confirmOrigin() {},
    cameraFor() {},
  }
}
