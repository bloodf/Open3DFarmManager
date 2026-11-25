import { computed, watch, type Ref } from 'vue'
import { useFarmControls } from '../components/farm/useFarmControls.ts'
import { useFarmView } from './useFarmView.ts'
import {
  liveReplayIndex,
  type LiveReplayInfo,
  type ReplaySend,
} from '../utils/replay-live.ts'
import {
  checkReplayConnection,
  replayWithFreshAvailability,
} from '../utils/replay-availability.ts'
import type { LibraryVersion } from '../utils/library-view.ts'
import { activeSlotSpools } from '../utils/slot-spools.ts'

/**
 * The live, signed session replay needs: which printers can be picked right
 * now and the one signed `start_library_print`. Client-only, like the farm view.
 */
export function useReplayLive(farmId: Ref<string>) {
  const view = useFarmView()
  watch(
    [farmId, view.ready],
    ([selected, current]) => {
      if (current && (current.scope?.farmId ?? '') !== selected)
        void view.selectFarm(selected)
    },
    { immediate: true },
  )
  const controls = useFarmControls(view, { value: null })
  const index = computed<ReadonlyMap<string, LiveReplayInfo>>(() => {
    const current =
      view.ready.value?.scope?.farmId === farmId.value ? view.ready.value : null
    return current
      ? liveReplayIndex(
          current.rows,
          current.keys,
          controls.pauseEnabled.value,
          view.now.value,
          (row) =>
            activeSlotSpools({
              farmId: farmId.value,
              row,
              inventory: current.spools,
              now: view.now.value,
            }),
        )
      : new Map()
  })
  const liveFor = (printerKey: string) => index.value.get(printerKey)
  const send: ReplaySend = async (
    printerKey,
    args,
    selectionCurrent = () => true,
    versionId,
  ) => {
    const scope = view.ready.value?.scope
    const row = view.ready.value?.rows.find(
      (item) => item.assignment.printerKey === printerKey,
    )
    if (!row || scope?.farmId !== farmId.value)
      return versionId
        ? { outcome: 'not-sent', code: 'stale-selection' }
        : { outcome: 'not-sent' }
    if (versionId) {
      try {
        const { version } = await $fetch<{ version: LibraryVersion }>(
          `/api/farms/${scope.farmId}/library/versions/${versionId}`,
          { retry: 0, timeout: 5_000, cache: 'no-store' },
        )
        if (
          version.id !== versionId ||
          version.sha256 !== args.sha256 ||
          version.deletedAt !== null ||
          version.purgedAt !== null
        )
          return { outcome: 'not-sent', code: 'stale-selection' }
      } catch (error) {
        return {
          outcome: 'not-sent',
          code:
            (error as { statusCode?: number })?.statusCode === 404
              ? 'stale-selection'
              : 'library-unavailable',
        }
      }
    }
    const { assignment } = row
    const abort = new AbortController()
    return replayWithFreshAvailability({
      isLive: () => !!liveFor(printerKey)?.live,
      current: () =>
        selectionCurrent() &&
        farmId.value === scope.farmId &&
        view.ready.value?.scope?.farmId === scope.farmId &&
        view.ready.value.scope.viewEpoch === scope.viewEpoch &&
        view.ready.value.rows.some(
          ({ assignment: current }) =>
            current.assignmentId === assignment.assignmentId &&
            current.agentId === assignment.agentId &&
            current.printerKey === assignment.printerKey &&
            current.status === 'active' &&
            current.connectorStatus === 'approved',
        ),
      connect: (onState) => controls.connectFiles(row, abort.signal, onState),
      args,
    })
  }
  send.reconnect = async (printerKey) => {
    const row = view.ready.value?.rows.find(
      (item) => item.assignment.printerKey === printerKey,
    )
    if (!row || view.ready.value?.scope?.farmId !== farmId.value) return false
    return checkReplayConnection((onState) =>
      controls.connectFiles(row, new AbortController().signal, onState),
    )
  }
  return { liveFor, send }
}
