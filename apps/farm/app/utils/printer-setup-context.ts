import { nextTick } from 'vue'
import { readBrowserDeviceScope } from './browser-device-enrollment.ts'
import { listDeviceKeys, type LocalDeviceKey } from './device-key.ts'
import { DEFAULT_KOBRA_X_SETUP_MODE } from './kobra-x-setup-mode.ts'
import { readConfigurationBootstrap } from './kobralink-onboarding.ts'
import type { createFarmData } from './printer-setup-farm.ts'
import type { createLiveStatus } from './printer-setup-live.ts'
import type { createPendingOperationStore } from './printer-setup-session.ts'
import type {
  BrowserKeyChoice,
  KobraEpoch,
  PrinterSetupRefs,
} from './printer-setup-state.ts'

type ContextDeps = ReturnType<typeof createFarmData> &
  ReturnType<typeof createLiveStatus> &
  ReturnType<typeof createPendingOperationStore> & {
    closeKobraSession(): void
  }

export function createKobraContext(
  state: PrinterSetupRefs,
  epoch: KobraEpoch,
  deps: ContextDeps,
) {
  const {
    farms,
    farmId,
    canManage,
    error,
    errorSummary,
    kobraAgentId,
    kobraKeyId,
    kobraKeyState,
    kobraBootstrap,
    selectedKobraKey,
    kobraIp,
    kobraSetupMode,
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
    discoveryPrinters,
    discoveryMessage,
    message,
    nextFarm,
    moonrakerApiKey,
    moonrakerUsername,
    moonrakerPassword,
    bambuAccessCode,
  } = state
  const {
    clear,
    run,
    loadAssignments,
    loadConnectors,
    clearKobraContext,
    closeLiveFeeds,
    startLiveStatusFeed,
    clearPersistedOperation,
    restorePersistedOperation,
    persistPendingOperation,
    closeKobraSession,
  } = deps

  async function loadKobraBrowserKeys(
    selectedFarm: string,
    token: number,
    signal: AbortSignal,
  ) {
    kobraKeyState.value = { kind: 'loading' }
    let scopePage
    try {
      scopePage = await readBrowserDeviceScope(selectedFarm, signal)
    } catch {
      if (token === epoch.generation()) {
        kobraKeyState.value = { kind: 'unavailable', reason: 'registry' }
      }
      return
    }
    if (token !== epoch.generation() || farmId.value !== selectedFarm) return
    if (scopePage.nextAfter !== null) {
      kobraKeyState.value = { kind: 'unavailable', reason: 'incomplete' }
      return
    }
    let localKeys: LocalDeviceKey[]
    try {
      localKeys = await listDeviceKeys({
        farmId: selectedFarm,
        accountId: scopePage.currentAccountId,
      })
    } catch {
      if (token === epoch.generation()) {
        kobraKeyState.value = { kind: 'unavailable', reason: 'storage' }
      }
      return
    }
    let verifyPage
    try {
      verifyPage = await readBrowserDeviceScope(selectedFarm, signal)
    } catch {
      if (token === epoch.generation()) {
        kobraKeyState.value = { kind: 'unavailable', reason: 'registry' }
      }
      return
    }
    if (token !== epoch.generation() || farmId.value !== selectedFarm) return
    if (verifyPage.currentAccountId !== scopePage.currentAccountId) {
      clear()
      farms.value = []
      farmId.value = ''
      error.value =
        'A conta mudou. Entre novamente e atualize a página antes de continuar.'
      await nextTick()
      errorSummary.value?.focus()
      return
    }
    const choices: BrowserKeyChoice[] = []
    let sawPending = false
    let sawRevoked = false
    for (const local of localKeys) {
      const match = verifyPage.devices.find(
        (d) =>
          d.accountId === verifyPage.currentAccountId &&
          d.thumbprint === local.thumbprint,
      )
      if (!match) continue
      if (match.status === 'approved') {
        choices.push({
          keyId: match.keyId,
          thumbprint: match.thumbprint,
          localKey: local,
        })
      } else if (match.status === 'pending') {
        sawPending = true
      } else if (match.status === 'revoked') {
        sawRevoked = true
      }
    }
    if (!choices.length) {
      kobraKeyId.value = ''
      kobraKeyState.value = {
        kind: 'unavailable',
        reason: sawPending ? 'pending' : sawRevoked ? 'revoked' : 'missing',
      }
      return
    }
    kobraKeyState.value = {
      kind: 'available',
      accountId: verifyPage.currentAccountId,
      choices: Object.freeze(choices),
    }
    if (!choices.some((c) => c.keyId === kobraKeyId.value)) {
      kobraKeyId.value = choices[0]!.keyId
    }
  }

  async function loadKobraBootstrap(token: number, signal: AbortSignal) {
    const currentFarm = farmId.value
    const targetAgent = kobraAgentId.value
    const keyChoice = selectedKobraKey.value
    if (!currentFarm || !targetAgent || !keyChoice) {
      kobraBootstrap.value = { kind: 'idle' }
      return
    }
    kobraBootstrap.value = { kind: 'loading' }
    try {
      const loaded = await readConfigurationBootstrap({
        farmId: currentFarm,
        agentId: targetAgent,
        keyId: keyChoice.keyId,
        signal,
      })
      if (token !== epoch.generation()) return
      if (!loaded.bootstrap.available || loaded.bootstrap.revision === null) {
        kobraBootstrap.value = {
          kind: 'unavailable',
          reason:
            'Configuração não disponível neste Connector. O Connector não anunciou suporte ativo ao protocolo config-v1.',
        }
        return
      }
      kobraBootstrap.value = { kind: 'ready', data: loaded }
    } catch (cause) {
      if (token !== epoch.generation()) return
      const status =
        cause && typeof cause === 'object' && 'statusCode' in cause
          ? Number(cause.statusCode)
          : cause && typeof cause === 'object' && 'status' in cause
            ? Number(cause.status)
            : undefined
      if (status === 401 || status === 403) {
        kobraBootstrap.value = {
          kind: 'unavailable',
          reason:
            'Permissão ou dispositivo revogado. Confira sua autorização na farm, o Connector e o dispositivo do navegador.',
        }
      } else if (status === 404) {
        kobraBootstrap.value = {
          kind: 'unavailable',
          reason: 'Configuração não disponível neste Connector ou ambiente.',
        }
      } else {
        kobraBootstrap.value = {
          kind: 'unavailable',
          reason:
            'Não foi possível consultar a capacidade de configuração deste Connector. Tente novamente.',
        }
      }
    }
  }

  async function refreshKobraContext(preserveUnresolvedOp = true) {
    discoveryPrinters.value = []
    discoveryMessage.value = ''
    const currentFarm = farmId.value
    clearKobraContext(true, preserveUnresolvedOp)
    closeLiveFeeds()
    if (!currentFarm || !canManage.value) return
    const token = epoch.generation()
    const currentController = new AbortController()
    epoch.setController(currentController)
    await loadKobraBrowserKeys(currentFarm, token, currentController.signal)
    if (token !== epoch.generation()) return
    if (preserveUnresolvedOp && kobraAgentId.value && kobraKeyId.value) {
      restorePersistedOperation(
        currentFarm,
        kobraAgentId.value,
        kobraKeyId.value,
      )
    }
    startLiveStatusFeed()
    await loadKobraBootstrap(token, currentController.signal)
  }

  function onKobraContextChange() {
    discoveryPrinters.value = []
    discoveryMessage.value = ''
    clearPersistedOperation()
    void refreshKobraContext(false)
  }

  async function selectFarm() {
    clear()
    message.value = ''
    if (!farmId.value) return
    await run(async (signal, current) => {
      await loadAssignments(signal, current)
      if (current === deps.currentGeneration() && canManage.value) {
        await loadConnectors(signal, current)
      }
    })
    if (farmId.value && canManage.value) {
      await refreshKobraContext()
    }
  }

  function abortLocalKobraWait() {
    if (!kobraBusy.value) return
    moonrakerApiKey.value = ''
    moonrakerUsername.value = ''
    moonrakerPassword.value = ''
    bambuAccessCode.value = ''
    epoch.next()
    epoch.controller()?.abort()
    epoch.setController(undefined)
    closeKobraSession()
    kobraBusy.value = false
    if (kobraOperation.value) {
      kobraStage.value = 'awaiting-reconcile'
      kobraUnknownNotice.value =
        'A espera local foi interrompida pelo usuário neste navegador.'
      persistPendingOperation(kobraOperation.value, 'awaiting-reconcile')
      kobraStatus.value =
        'Espera local interrompida. Isso não confirma reversão remota no Connector; consulte o estado da operação para verificar.'
    } else {
      kobraStage.value = 'idle'
      kobraStatus.value = 'Operação local interrompida.'
    }
  }

  function resetKobraForm() {
    clearPersistedOperation()
    kobraError.value = ''
    kobraStatus.value = ''
    kobraStage.value = 'idle'
    kobraCommitConfirmed.value = false
    kobraUnknownNotice.value = ''
    kobraRecoveryReason.value = null
    kobraOperation.value = null
    kobraPrepared.value = null
    kobraConfirmed.value = null
    kobraIp.value = ''
    kobraSetupMode.value = DEFAULT_KOBRA_X_SETUP_MODE
    kobraLabel.value = ''
    kobraExpectedDeviceId.value = ''
  }

  return {
    loadKobraBootstrap,
    refreshKobraContext,
    onKobraContextChange,
    selectFarm,
    abortLocalKobraWait,
    resetKobraForm,
  }
}
