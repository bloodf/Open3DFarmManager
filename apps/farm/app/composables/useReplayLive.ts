import { computed } from 'vue'
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
 */
export function useReplayLive() {
  const view = useFarmView()
  const controls = useFarmControls(view, { value: null })
  const index = computed<ReadonlyMap<string, LiveReplayInfo>>(() => {
    const current = view.ready.value
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
    const row = view.ready.value?.rows.find(
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
