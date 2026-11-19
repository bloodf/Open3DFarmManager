import { computed, toValue, watchEffect, type MaybeRefOrGetter } from 'vue'
import { useFarmControls } from '../components/farm/useFarmControls.ts'
import { useFarmView } from './useFarmView.ts'
import type { LibraryPrintArgs } from '../../../../packages/farm-protocol/src/control-actions.ts'
import {
  liveReplayIndex,
  sendLibraryReplay,
  type LiveReplayInfo,
} from '../utils/replay-live.ts'
import type { ReplayResult } from '../utils/replay-view.ts'

/**
 * The live, signed session replay needs: which printers can be picked right
 * now and the one signed `start_library_print`. Client-only, like the farm view.
 *
 * `farmId` is the farm that owns the job or library version being replayed.
 * The view selects a farm on its own only for single-farm accounts, so with
 * two or more farms it is selected here; printers and sends only ever come
 * from that farm's scope.
 */
export function useReplayLive(farmId: MaybeRefOrGetter<string>) {
  const view = useFarmView()
  const controls = useFarmControls(view, { value: null })
  watchEffect(() => {
    const target = toValue(farmId)
    const current = view.ready.value
    if (!target || !current || current.scope?.farmId === target) return
    if (!current.farms.some((farm) => farm.farmId === target)) return
    void view.selectFarm(target)
  })
  const scoped = () => {
    const current = view.ready.value
    const target = toValue(farmId)
    return current && target && current.scope?.farmId === target
      ? current
      : null
  }
  const index = computed<ReadonlyMap<string, LiveReplayInfo>>(() => {
    const current = scoped()
    return current
      ? liveReplayIndex(
          current.rows,
          current.keys,
          controls.pauseEnabled.value,
          view.now.value,
        )
      : new Map()
  })
  const liveFor = (printerKey: string) => index.value.get(printerKey)
  async function send(
    printerKey: string,
    args: LibraryPrintArgs,
  ): Promise<ReplayResult> {
    const row = scoped()?.rows.find(
      (item) => item.assignment.printerKey === printerKey,
    )
    if (!row || !liveFor(printerKey)?.live) return { outcome: 'not-sent' }
    const abort = new AbortController()
    return sendLibraryReplay(
      (onState) => controls.connectFiles(row, abort.signal, onState),
      args,
    )
  }
  return { liveFor, send }
}
