import type { Ref } from 'vue'
import type { NetworkAdoption } from './network-adoption.ts'
import { listenForAuthInvalidation } from './auth-invalidation.ts'
import type { openPrinterDiscoverySession } from './printer-discovery-view-session.ts'
import { createKobraContext } from './printer-setup-context.ts'
import { createPrinterDiscovery } from './printer-setup-discovery.ts'
import { createFarmData } from './printer-setup-farm.ts'
import { createLiveStatus } from './printer-setup-live.ts'
import { createKobraOperation } from './printer-setup-operation.ts'
import {
  createConfigurationSession,
  createPendingOperationStore,
} from './printer-setup-session.ts'
import type {
  KobraEpoch,
  KobraOperationContext,
  PrinterSetupRefs,
} from './printer-setup-state.ts'

type Hooks = {
  adoption?: Ref<NetworkAdoption | null>
  handleKobraException(
    cause: unknown,
    opContext: KobraOperationContext | null,
    token: number,
    wasMutating: boolean,
  ): Promise<void>
  openPrinterDiscoverySession: typeof openPrinterDiscoverySession
}

// Wires the setup modules in dependency order and returns every action.
export function createPrinterSetup(
  state: PrinterSetupRefs,
  epoch: KobraEpoch,
  { handleKobraException, openPrinterDiscoverySession, adoption }: Hooks,
) {
  const live = createLiveStatus(state, epoch)
  const pendingOps = createPendingOperationStore(state)
  const session = createConfigurationSession(state, epoch)
  const farm = createFarmData(state, epoch, { ...live, ...session })
  const deps = { ...farm, ...live, ...pendingOps, ...session }
  const context = createKobraContext(state, epoch, deps)
  const operation = createKobraOperation(
    state,
    epoch,
    { ...deps, ...context },
    handleKobraException,
  )
  const discovery = createPrinterDiscovery(
    state,
    epoch.controller,
    session.closeKobraSession,
    openPrinterDiscoverySession,
  )
  // Starts the live-age ticker and the cross-tab sign-out listener.
  function watchSession() {
    const { farms, farmId, nextFarm, error, liveTick } = state
    const tick = setInterval(() => {
      liveTick.value = { wall: Date.now(), mono: performance.now() }
    }, 1000)
    const stop = listenForAuthInvalidation(() => {
      farm.clear()
      pendingOps.clearPersistedOperation()
      farms.value = []
      farmId.value = ''
      nextFarm.value = null
      error.value =
        'A conta mudou em outra aba. Entre novamente e atualize a página antes de continuar.'
    })
    return () => {
      clearInterval(tick)
      stop()
    }
  }
  async function initialize() {
    const target = adoption?.value
    if (adoption) adoption.value = null
    const loaded = farm.loadFarms()
    const generation = farm.currentGeneration()
    await loaded
    if (!target || state.error.value || generation !== farm.currentGeneration())
      return
    state.farmId.value = target.farmId
    await context.selectFarm()
    if (!state.canManage.value || state.farmId.value !== target.farmId) return
    const hasConnector = () =>
      state.connectors.value.some(
        (connector) => connector.agentId === target.agentId,
      )
    if (!hasConnector() && state.nextConnector.value) {
      await farm.run(async (signal, current) => {
        while (
          !signal.aborted &&
          !hasConnector() &&
          state.nextConnector.value
        ) {
          await farm.loadConnectors(signal, current, state.nextConnector.value)
        }
      })
    }
    if (!state.canManage.value || state.farmId.value !== target.farmId) return
    if (!hasConnector()) {
      state.message.value =
        'O Connector da impressora descoberta está indisponível.'
      return
    }
    if (state.kobraAgentId.value !== target.agentId) {
      state.kobraAgentId.value = target.agentId
      await context.refreshKobraContext()
    }
    if (
      state.canManage.value &&
      state.farmId.value === target.farmId &&
      state.kobraAgentId.value === target.agentId &&
      !state.kobraOperation.value
    )
      discovery.selectDiscovery(target.printer)
  }
  return {
    ...deps,
    ...context,
    ...operation,
    ...discovery,
    watchSession,
    initialize,
  }
}
