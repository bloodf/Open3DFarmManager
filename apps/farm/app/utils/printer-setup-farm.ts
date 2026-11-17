import { nextTick } from 'vue'
import type {
  KobraEpoch,
  Printer,
  PrinterSetupRefs,
} from './printer-setup-state.ts'

type FarmDeps = {
  closeLiveFeeds(): void
  startLiveStatusFeed(): void
  closeKobraSession(): void
}

export function createFarmData(
  state: PrinterSetupRefs,
  epoch: KobraEpoch,
  { closeLiveFeeds, startLiveStatusFeed, closeKobraSession }: FarmDeps,
) {
  const {
    farms,
    farmId,
    printers,
    connectors,
    nextFarm,
    nextPrinter,
    nextConnector,
    canManage,
    pending,
    error,
    message,
    agentId,
    printerKey,
    confirmed,
    revokeTarget,
    revokeConfirmed,
    errorSummary,
    kobraAgentId,
    kobraKeyId,
    kobraKeyState,
    kobraBootstrap,
    kobraIp,
    kobraLabel,
    kobraExpectedDeviceId,
    kobraBusy,
    kobraError,
    kobraStatus,
    kobraStage,
    kobraCommitConfirmed,
    kobraUnknownNotice,
    kobraRecoveryReason,
    kobraOperation,
    kobraPrepared,
    kobraConfirmed,
    liveObservations,
    moonrakerApiKey,
    moonrakerUsername,
    moonrakerPassword,
    bambuAccessCode,
  } = state
  let generation = 0,
    controller: AbortController | undefined

  function clearKobraContext(
    preserveSelection = false,
    preserveUnresolvedOp = false,
  ) {
    moonrakerApiKey.value = ''
    moonrakerUsername.value = ''
    moonrakerPassword.value = ''
    bambuAccessCode.value = ''
    epoch.next()
    epoch.controller()?.abort()
    epoch.setController(undefined)
    closeKobraSession()
    kobraBusy.value = false
    kobraBootstrap.value = { kind: 'idle' }
    if (!preserveUnresolvedOp) {
      kobraError.value = ''
      kobraStatus.value = ''
      kobraStage.value = 'idle'
      kobraCommitConfirmed.value = false
      kobraUnknownNotice.value = ''
      kobraRecoveryReason.value = null
      kobraOperation.value = null
      kobraPrepared.value = null
      kobraConfirmed.value = null
    }
    if (!preserveSelection) {
      kobraAgentId.value = ''
      kobraKeyId.value = ''
      kobraKeyState.value = { kind: 'idle' }
      kobraIp.value = ''
      kobraLabel.value = ''
      kobraExpectedDeviceId.value = ''
    }
  }

  function clear() {
    generation++
    controller?.abort()
    controller = undefined
    closeLiveFeeds()
    clearKobraContext(false)
    printers.value = []
    connectors.value = []
    liveObservations.value = {}
    canManage.value = false
    nextPrinter.value = null
    nextConnector.value = null
    agentId.value = ''
    printerKey.value = ''
    confirmed.value = false
    revokeTarget.value = null
    revokeConfirmed.value = false
  }

  async function run(
    work: (signal: AbortSignal, current: number) => Promise<void>,
  ) {
    if (pending.value) return
    pending.value = true
    error.value = ''
    const current = generation
    controller = new AbortController()
    try {
      await work(controller.signal, current)
    } catch {
      if (current === generation) {
        clear()
        farms.value = []
        farmId.value = ''
        nextFarm.value = null
        error.value =
          'Não foi possível confirmar os dados. Entre novamente e atualize a página antes de continuar.'
        await nextTick()
        errorSummary.value?.focus()
      }
    } finally {
      if (current === generation || error.value) pending.value = false
    }
  }

  function options(signal: AbortSignal) {
    return { signal, retry: 0, timeout: 10000 }
  }

  async function loadFarms(after: string | null = null) {
    if (pending.value) return
    clear()
    farmId.value = ''
    message.value = ''
    await run(async (signal, current) => {
      const page = await $fetch<{
        farms: { farmId: string }[]
        nextAfter: string | null
      }>('/api/farms', { ...options(signal), query: after ? { after } : {} })
      if (current !== generation) return
      farms.value = page.farms
      nextFarm.value = page.nextAfter
    })
  }

  async function loadAssignments(
    signal: AbortSignal,
    current: number,
    after: string | null = null,
  ) {
    const page = await $fetch<{
      printers: Printer[]
      nextAfter: string | null
      canManage: boolean
    }>('/api/farms/' + farmId.value + '/printers', {
      ...options(signal),
      query: after ? { after } : {},
    })
    if (current !== generation) return
    revokeTarget.value = null
    revokeConfirmed.value = false
    printers.value = page.printers
    nextPrinter.value = page.nextAfter
    canManage.value = page.canManage
  }

  async function loadConnectors(
    signal: AbortSignal,
    current: number,
    after: string | null = null,
  ) {
    const page = await $fetch<{
      connectors: { agentId: string; fingerprint: string; status: string }[]
      nextAfter: string | null
    }>('/api/farms/' + farmId.value + '/connectors', {
      ...options(signal),
      query: after ? { after } : {},
    })
    if (current !== generation) return
    agentId.value = ''
    confirmed.value = false
    connectors.value = page.connectors.filter((c) => c.status === 'approved')
    nextConnector.value = page.nextAfter
    if (connectors.value.length === 1 && !kobraAgentId.value) {
      kobraAgentId.value = connectors.value[0]!.agentId
    }
  }

  function cancelRevocation() {
    revokeTarget.value = null
    revokeConfirmed.value = false
  }

  function selectRevocation(printer: Printer) {
    revokeTarget.value = printer
    revokeConfirmed.value = false
  }

  async function register() {
    if (
      !confirmed.value ||
      !agentId.value ||
      !printerKey.value ||
      !canManage.value
    )
      return
    await run(async (signal, current) => {
      await $fetch('/api/farms/' + farmId.value + '/printers', {
        ...options(signal),
        method: 'POST',
        body: {
          agentId: agentId.value,
          printerKey: printerKey.value,
          confirmedLocalConfiguration: true,
        },
      })
      if (current !== generation) return
      printerKey.value = ''
      confirmed.value = false
      message.value =
        'Atribuição registrada. Isso não confirma conexão com a impressora nem autoriza comandos.'
      await loadAssignments(signal, current)
    })
    startLiveStatusFeed()
  }

  async function revoke() {
    const target = revokeTarget.value
    if (!target || !revokeConfirmed.value || !canManage.value) return
    await run(async (signal, current) => {
      await $fetch(
        '/api/farms/' +
          farmId.value +
          '/printers/' +
          target.assignmentId +
          '/revoke',
        {
          ...options(signal),
          method: 'POST',
          body: { agentId: target.agentId, printerKey: target.printerKey },
        },
      )
      if (current !== generation) return
      revokeTarget.value = null
      revokeConfirmed.value = false
      message.value =
        'Atribuição revogada permanentemente. Uma reatribuição exige um novo cadastro.'
      await loadAssignments(signal, current)
    })
    startLiveStatusFeed()
  }

  return {
    clearKobraContext,
    clear,
    run,
    loadFarms,
    loadAssignments,
    loadConnectors,
    cancelRevocation,
    selectRevocation,
    register,
    revoke,
    currentGeneration: () => generation,
  }
}
