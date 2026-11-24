import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from 'vue'
import { type useFarmView } from '../../composables/useFarmView.ts'
import { type FarmRow } from '../../utils/farm-view.ts'
import { macroArgs } from '../../utils/farm-macros.ts'
import {
  controlStatusText,
  extendedControlStatusText,
  liveControlActionAvailability,
} from '../../utils/farm-control.ts'
import { livePauseAvailability } from '../../utils/farm-pause.ts'
import type {
  ControlAction,
  ExtendedControlAction,
} from '../../../../../packages/farm-protocol/src/control-actions.ts'
import {
  openFarmPauseControl,
  PAUSE_CAPABILITY_MARGIN_MS,
  type FarmPauseControl,
  type FarmPauseControlState,
} from '../../utils/webrtc/farm-pause-control.ts'
import { createFarmStatusKeyResolver } from '../../utils/webrtc/farm-status-key-resolver.ts'
import { pauseResultDriverFamilyFromIdentity } from '../../utils/webrtc/pause-command-client.ts'

export function useFarmControls(
  { ready, now }: ReturnType<typeof useFarmView>,
  dialog: Readonly<{ value: { show(): void; close(): void } | null }>,
) {
  // Pause control: one confirmed, signed command per session over WebRTC only.
  const pauseEnabled = ref(false)
  onMounted(async () => {
    try {
      const metadata = await $fetch<unknown>('/api/signalling/pause-metadata', {
        retry: 0,
        timeout: 10_000,
        cache: 'no-store',
      })
      pauseEnabled.value =
        !!metadata &&
        typeof metadata === 'object' &&
        'enabled' in metadata &&
        metadata.enabled === true &&
        'origin' in metadata &&
        metadata.origin === location.origin
    } catch {
      pauseEnabled.value = false
    }
  })
  function availability(row: FarmRow) {
    const current = ready.value
    void now.value
    return current
      ? livePauseAvailability(row, current.keys, pauseEnabled.value)
      : { available: false as const, reason: '' }
  }
  const pauseTarget = shallowRef<{
    assignmentId: string
    printerKey: string
    action: ExtendedControlAction
    args: Record<string, unknown>
  } | null>(null)
  const pauseState = shallowRef<FarmPauseControlState>({ kind: 'connecting' })
  const pauseLost = ref(false)
  const lastControlResults = ref<Record<string, string>>({})
  let pauseControl: FarmPauseControl | undefined
  let pauseTrigger: HTMLElement | null = null
  const pauseRemaining = computed(() =>
    pauseState.value.kind === 'ready'
      ? Math.floor(
          (pauseState.value.expiresAt -
            PAUSE_CAPABILITY_MARGIN_MS -
            now.value.wall) /
            1000,
        )
      : 0,
  )
  const pauseStatus = computed(() => {
    if (!pauseTarget.value) return ''
    if (
      pauseLost.value &&
      (pauseState.value.kind === 'failed' ||
        pauseState.value.kind === 'connecting')
    ) {
      return 'O estado da impressora deixou de estar ao vivo. Nenhum comando foi enviado.'
    }
    if (!['pause', 'resume', 'cancel'].includes(pauseTarget.value.action)) {
      return extendedControlStatusText(pauseState.value, pauseRemaining.value)
    }
    return controlStatusText(
      pauseTarget.value.action as ControlAction,
      pauseState.value,
      pauseRemaining.value,
    )
  })
  const pauseResolver = createFarmStatusKeyResolver({
    readMetadata: async (signal) =>
      await $fetch<unknown>('/api/signalling/pause-metadata', {
        signal,
        retry: 0,
        timeout: 10_000,
        cache: 'no-store',
      }),
    isCurrent(scope, keyId) {
      const current = ready.value
      return (
        !!current &&
        current.accountId === scope.accountId &&
        current.scope?.accountId === scope.accountId &&
        current.scope.farmId === scope.farmId &&
        current.scope.viewEpoch === scope.viewEpoch &&
        current.keys.kind === 'available' &&
        current.keys.selected === keyId
      )
    },
  })
  function connectControl(
    row: FarmRow,
    scope: NonNullable<NonNullable<typeof ready.value>['scope']>,
    keyId: string,
    onState: Parameters<typeof openFarmPauseControl>[0]['onState'],
  ) {
    return openFarmPauseControl({
      accountId: scope.accountId,
      farmId: scope.farmId,
      keyId,
      agentId: row.assignment.agentId,
      assignmentId: row.assignment.assignmentId,
      driverFamily: pauseResultDriverFamilyFromIdentity(
        row.observation?.state.identity,
      ),
      async resolveKey(signal) {
        const resolved = await pauseResolver({
          scope,
          browserKeyId: keyId,
          signal,
        })
        return {
          publicKey: resolved.localKey.publicKey,
          privateKey: resolved.localKey.keyPair.privateKey,
          origin: resolved.origin,
          audience: resolved.audience,
        }
      },
      onState,
    })
  }
  async function connectFiles(
    row: FarmRow,
    signal: AbortSignal,
    observe?: (state: FarmPauseControlState) => void,
  ) {
    const current = ready.value
    if (
      !current?.scope ||
      current.keys.kind !== 'available' ||
      !pauseEnabled.value
    )
      throw Error('File session unavailable')
    signal.throwIfAborted()
    const { scope, keys } = current
    let control: ReturnType<typeof openFarmPauseControl> | undefined
    const abort = () => control?.close()
    signal.addEventListener('abort', abort, { once: true })
    try {
      await new Promise<void>((resolve, reject) => {
        control = connectControl(row, scope, keys.selected, (state) => {
          observe?.(state)
          if (state.kind === 'ready') resolve()
          if (state.kind === 'failed' || state.kind === 'settled')
            reject(Error('File session closed'))
        })
      })
      signal.throwIfAborted()
      if (!control) throw Error('File session unavailable')
      return control
    } catch (error) {
      control?.close()
      await control?.dispose()
      throw error
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }
  async function openControl(
    row: FarmRow,
    action: ExtendedControlAction,
    event: Event,
    args: Record<string, unknown> = {},
  ) {
    const current = ready.value
    if (
      (action === 'run_macro' &&
        !macroArgs(row.observation?.state, String(args.name ?? ''))) ||
      !current?.scope ||
      current.keys.kind !== 'available' ||
      !liveControlActionAvailability(
        action,
        row,
        current.keys,
        pauseEnabled.value,
      ).available ||
      pauseControl
    )
      return
    const scope = current.scope,
      keyId = current.keys.selected
    pauseTrigger =
      event.currentTarget instanceof HTMLElement ? event.currentTarget : null
    pauseLost.value = false
    pauseState.value = { kind: 'connecting' }
    pauseTarget.value = {
      assignmentId: row.assignment.assignmentId,
      printerKey: row.assignment.printerKey,
      action,
      args,
    }
    pauseControl = connectControl(row, scope, keyId, (state) => {
      pauseState.value = state
      if (state.kind === 'settled' && pauseTarget.value) {
        lastControlResults.value[pauseTarget.value.assignmentId] =
          state.kind === 'settled' &&
          !['pause', 'resume', 'cancel'].includes(pauseTarget.value.action)
            ? extendedControlStatusText(state, 0)
            : controlStatusText(
                pauseTarget.value.action as ControlAction,
                state,
                0,
              )
      }
    })
    await nextTick()
    dialog.value?.show()
  }
  function confirmControl() {
    if (pauseState.value.kind === 'ready' && pauseTarget.value) {
      const row = ready.value?.rows.find(
        (item) =>
          item.assignment.assignmentId === pauseTarget.value?.assignmentId,
      )
      if (
        !row ||
        !ready.value ||
        !liveControlActionAvailability(
          pauseTarget.value.action,
          row,
          ready.value.keys,
          pauseEnabled.value,
        ).available ||
        (pauseTarget.value.action === 'run_macro' &&
          !macroArgs(
            row.observation?.state,
            String(pauseTarget.value.args.name ?? ''),
          ))
      )
        return
      void pauseControl?.issueControlCommand(
        pauseTarget.value.action,
        pauseTarget.value.args,
      )
    }
  }
  function closePause() {
    // A command in flight keeps its session until its outcome settles.
    if (pauseState.value.kind === 'sending') return
    const control = pauseControl
    pauseControl = undefined
    control?.close()
    void control?.dispose()
    dialog.value?.close()
    pauseTarget.value = null
    pauseTrigger?.focus()
    pauseTrigger = null
  }
  watch([() => ready.value?.rows, now], () => {
    const target = pauseTarget.value
    if (!target || !pauseControl) return
    const kind = pauseState.value.kind
    if (kind !== 'connecting' && kind !== 'ready') return
    const row = ready.value?.rows.find(
      (item) => item.assignment.assignmentId === target.assignmentId,
    )
    if (
      !row ||
      (target.action === 'run_macro' &&
        !macroArgs(row.observation?.state, String(target.args.name ?? ''))) ||
      !ready.value ||
      !liveControlActionAvailability(
        target.action,
        row,
        ready.value.keys,
        pauseEnabled.value,
      ).available
    ) {
      pauseLost.value = true
      pauseControl.close()
    }
  })
  onBeforeUnmount(() => {
    const control = pauseControl
    pauseControl = undefined
    control?.close()
    void control?.dispose()
  })

  const commandInFlight = computed(
    () =>
      pauseState.value.kind !== 'settled' &&
      pauseState.value.kind !== 'failed' &&
      pauseTarget.value !== null,
  )
  return {
    pauseEnabled,
    availability,
    pauseTarget,
    pauseState,
    pauseLost,
    lastControlResults,
    pauseRemaining,
    pauseStatus,
    openControl,
    connectFiles,
    confirmControl,
    closePause,
    commandInFlight,
  }
}
