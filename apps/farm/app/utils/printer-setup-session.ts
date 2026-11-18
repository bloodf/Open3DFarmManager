import { withoutAnycubicCredentials } from './anycubic-onboarding.ts'
import { withoutBambuAccessCode } from './bambu-onboarding.ts'
import { sanitizeTargetForClientStorage } from './kobra-client-cert-ui.ts'
import {
  openConfigurationBrowserSession,
  type ConfigurationBrowserSession,
} from './kobralink-onboarding.ts'
import { withoutMoonrakerKey } from './moonraker-onboarding.ts'
import { openMoonrakerConfigurationBrowserSession } from './moonraker-onboarding-session.ts'
import type { ConfigurationTarget } from '../../../../packages/farm-protocol/src/configuration-target.ts'
import type {
  KobraEpoch,
  KobraOperationContext,
  KobraStage,
  PrinterSetupRefs,
} from './printer-setup-state.ts'

const PENDING_OP_SESSION_KEY = 'openfarm:kobra-x-pending-op'

export function createPendingOperationStore(state: PrinterSetupRefs) {
  const {
    kobraOperation,
    kobraStage,
    kobraKeyState,
    kobraUnknownNotice,
    kobraRecoveryReason,
  } = state

  function persistPendingOperation(
    op: KobraOperationContext | null,
    stage: KobraStage,
  ) {
    if (typeof window === 'undefined') return
    try {
      if (!op || stage === 'idle' || stage === 'confirmed') {
        window.sessionStorage.removeItem(PENDING_OP_SESSION_KEY)
        return
      }
      window.sessionStorage.setItem(
        PENDING_OP_SESSION_KEY,
        JSON.stringify({
          accountId: op.accountId,
          operationId: op.operationId,
          farmId: op.farmId,
          agentId: op.agentId,
          keyId: op.keyId,
          target: sanitizeTargetForClientStorage(
            op.target.backend === 'anycubic'
              ? withoutAnycubicCredentials(op.target)
              : op.target.backend === 'moonraker'
                ? withoutMoonrakerKey(op.target)
                : op.target.backend === 'bambu'
                  ? withoutBambuAccessCode(op.target)
                  : op.target,
          ),
          targetSha256: op.targetSha256,
          expectedRevision: op.expectedRevision,
          displayLabel: op.displayLabel,
          stage:
            stage === 'recovery-required'
              ? 'recovery-required'
              : 'awaiting-reconcile',
          unknownNotice:
            kobraUnknownNotice.value ||
            'Operação em andamento antes da recarga. Consulte o estado no Connector antes de repetir.',
          recoveryReason: kobraRecoveryReason.value,
        }),
      )
    } catch {}
  }

  function clearPersistedOperation() {
    if (typeof window === 'undefined') return
    try {
      window.sessionStorage.removeItem(PENDING_OP_SESSION_KEY)
    } catch {}
  }

  function restorePersistedOperation(
    currentFarm: string,
    currentAgent: string,
    currentKey: string,
  ) {
    if (typeof window === 'undefined' || kobraOperation.value) return
    try {
      const raw = window.sessionStorage.getItem(PENDING_OP_SESSION_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as {
        accountId?: string
        operationId?: string
        farmId?: string
        agentId?: string
        keyId?: string
        target?: ConfigurationTarget
        targetSha256?: string
        expectedRevision?: number
        displayLabel?: string
        stage?: 'awaiting-reconcile' | 'recovery-required'
        unknownNotice?: string
        recoveryReason?: string | null
      }
      if (
        !parsed ||
        kobraKeyState.value.kind !== 'available' ||
        parsed.accountId !== kobraKeyState.value.accountId ||
        parsed.farmId !== currentFarm ||
        parsed.agentId !== currentAgent ||
        parsed.keyId !== currentKey ||
        typeof parsed.operationId !== 'string' ||
        typeof parsed.targetSha256 !== 'string' ||
        typeof parsed.expectedRevision !== 'number' ||
        !parsed.target
      )
        return
      kobraOperation.value = {
        accountId: parsed.accountId,
        operationId: parsed.operationId,
        farmId: parsed.farmId,
        agentId: parsed.agentId,
        keyId: parsed.keyId,
        target: parsed.target,
        targetSha256: parsed.targetSha256,
        expectedRevision: parsed.expectedRevision,
        displayLabel: parsed.displayLabel ?? '',
        preparedReceipt: null,
        preparedReceiptSha256: null,
      }
      kobraStage.value = parsed.stage ?? 'awaiting-reconcile'
      kobraUnknownNotice.value =
        parsed.unknownNotice ??
        'Operação pendente restaurada nesta aba. Consulte o estado no Connector antes de iniciar outra.'
      kobraRecoveryReason.value = parsed.recoveryReason ?? null
    } catch {}
  }

  return {
    persistPendingOperation,
    clearPersistedOperation,
    restorePersistedOperation,
  }
}

export function createConfigurationSession(
  state: PrinterSetupRefs,
  epoch: KobraEpoch,
) {
  const {
    farmId,
    kobraAgentId,
    kobraKeyState,
    kobraBootstrap,
    selectedKobraKey,
    onboardingFamily,
    isMoonrakerOnboarding,
    anycubicUsername,
    anycubicPassword,
  } = state
  let kobraSession: ConfigurationBrowserSession | undefined

  function closeKobraSession() {
    const active = kobraSession
    kobraSession = undefined
    if (active) {
      active.close()
      void active.dispose()
    }
    anycubicUsername.value = ''
    anycubicPassword.value = ''
    state.clearKobraClientCert()
  }

  async function ensureKobraSession(
    signal: AbortSignal,
  ): Promise<ConfigurationBrowserSession> {
    if (kobraSession?.isAlive()) return kobraSession
    closeKobraSession()
    const keyState = kobraKeyState.value
    const keyChoice = selectedKobraKey.value
    const boot = kobraBootstrap.value
    if (
      !farmId.value ||
      !kobraAgentId.value ||
      keyState.kind !== 'available' ||
      !keyChoice ||
      boot.kind !== 'ready'
    ) {
      throw new Error('Contexto de configuração indisponível.')
    }
    const token = epoch.generation()
    const session = await (
      isMoonrakerOnboarding.value ||
        onboardingFamily.value === 'klipper-moonraker'
        ? openMoonrakerConfigurationBrowserSession
        : openConfigurationBrowserSession
    )({
      accountId: keyState.accountId,
      farmId: farmId.value,
      agentId: kobraAgentId.value,
      keyId: keyChoice.keyId,
      localKey: keyChoice.localKey,
      bootstrap: boot.data,
      signal,
    })
    if (token !== epoch.generation() || signal.aborted) {
      session.close()
      throw new Error('Configuration context changed before connection')
    }
    kobraSession = session
    return session
  }

  return { closeKobraSession, ensureKobraSession }
}
