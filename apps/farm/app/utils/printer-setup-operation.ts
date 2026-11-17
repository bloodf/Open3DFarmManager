import { nextTick } from 'vue'
import { describeAnycubicConfigurationError } from './anycubic-onboarding.ts'
import { describeBambuConfigurationError } from './bambu-onboarding.ts'
import { describeCrealityConfigurationError } from './creality-onboarding.ts'
import {
  describeConfigurationError,
  describeRecoveryReason,
  describeUnknownReason,
  type ConfigurationSessionOutcome,
} from './kobralink-onboarding.ts'
import { describeMoonrakerConfigurationError } from './moonraker-onboarding.ts'
import type { createFarmData } from './printer-setup-farm.ts'
import type { createLiveStatus } from './printer-setup-live.ts'
import type { createKobraContext } from './printer-setup-context.ts'
import type {
  createConfigurationSession,
  createPendingOperationStore,
} from './printer-setup-session.ts'
import type {
  KobraEpoch,
  KobraOperationContext,
  PrinterSetupRefs,
} from './printer-setup-state.ts'

type OperationDeps = ReturnType<typeof createFarmData> &
  ReturnType<typeof createLiveStatus> &
  ReturnType<typeof createPendingOperationStore> &
  ReturnType<typeof createConfigurationSession> &
  ReturnType<typeof createKobraContext>

type HandleException = (
  cause: unknown,
  opContext: KobraOperationContext | null,
  token: number,
  wasMutating: boolean,
) => Promise<void>

export function createKobraOperation(
  state: PrinterSetupRefs,
  epoch: KobraEpoch,
  deps: OperationDeps,
  handleKobraException: HandleException,
) {
  const {
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
    kobraDisplayLabels,
    kobraErrorSummary,
    isAnycubicOnboarding,
    isBambuOnboarding,
    isCrealityOnboarding,
  } = state
  const {
    loadAssignments,
    startLiveStatusFeed,
    persistPendingOperation,
    clearPersistedOperation,
    closeKobraSession,
    ensureKobraSession,
    loadKobraBootstrap,
  } = deps

  const describeBackendError = (code: string) =>
    (isAnycubicOnboarding.value
      ? describeAnycubicConfigurationError(code)
      : null) ??
    describeMoonrakerConfigurationError(code) ??
    (isBambuOnboarding.value ? describeBambuConfigurationError(code) : null) ??
    (isCrealityOnboarding.value
      ? describeCrealityConfigurationError(code)
      : null)

  async function applySessionOutcome(
    outcome: ConfigurationSessionOutcome,
    opContext: KobraOperationContext,
    token: number,
    signal: AbortSignal,
  ) {
    if (token !== epoch.generation()) return
    switch (outcome.kind) {
      case 'prepared': {
        kobraOperation.value = {
          ...opContext,
          preparedReceipt: outcome.receipt,
          preparedReceiptSha256: outcome.receiptSha256,
        }
        kobraPrepared.value = { ...outcome, target: opContext.target }
        kobraCommitConfirmed.value = false
        kobraStage.value = 'prepared'
        kobraStatus.value =
          'Identidade da impressora observada pelo Connector. Confira os dados e confirme para ativar.'
        persistPendingOperation(kobraOperation.value, 'prepared')
        return
      }
      case 'local-committed': {
        kobraStage.value = 'awaiting-reconcile'
        kobraUnknownNotice.value =
          'A configuração local foi gravada no Connector, mas aguarda confirmação de inventário.'
        kobraStatus.value =
          'Configuração gravada localmente no Connector; reconcilie a operação para confirmar o inventário.'
        persistPendingOperation(opContext, 'awaiting-reconcile')
        return
      }
      case 'inventory-confirmed': {
        if (opContext.displayLabel) {
          kobraDisplayLabels.value = {
            ...kobraDisplayLabels.value,
            [outcome.printerKey]: opContext.displayLabel,
          }
        }
        kobraConfirmed.value = outcome
        kobraPrepared.value = null
        kobraStage.value = 'confirmed'
        clearPersistedOperation()
        kobraStatus.value =
          'Impressora adicionada e confirmada com recibo assinado pelo Connector.'
        await loadAssignments(signal, deps.currentGeneration())
        await loadKobraBootstrap(token, signal)
        startLiveStatusFeed()
        return
      }
      case 'recovery-required': {
        kobraRecoveryReason.value = outcome.reason
        kobraStage.value = 'recovery-required'
        persistPendingOperation(opContext, 'recovery-required')
        kobraError.value =
          'Recuperação pendente no Connector: ' +
          describeRecoveryReason(outcome.reason) +
          ' A ativação automática foi bloqueada para proteger as demais impressoras.'
        await nextTick()
        kobraErrorSummary.value?.focus()
        return
      }
      case 'unknown': {
        if (outcome.reason === 'cancel-acknowledged') {
          kobraOperation.value = null
          kobraPrepared.value = null
          kobraStage.value = 'idle'
          clearPersistedOperation()
          kobraStatus.value =
            'Operação cancelada no Connector. Nenhuma atribuição foi ativada.'
          await loadKobraBootstrap(token, signal)
          return
        }
        kobraUnknownNotice.value = describeUnknownReason(outcome.reason)
        kobraStage.value = 'awaiting-reconcile'
        persistPendingOperation(opContext, 'awaiting-reconcile')
        kobraError.value =
          describeUnknownReason(outcome.reason) +
          ' Consulte e reconcilie a operação antes de iniciar outra.'
        await nextTick()
        kobraErrorSummary.value?.focus()
        return
      }
      case 'error': {
        if (outcome.code === 'revision-conflict') {
          await loadKobraBootstrap(token, signal)
        }
        kobraError.value =
          describeBackendError(outcome.code) ??
          describeConfigurationError(outcome.code)
        if (kobraStage.value === 'preparing') kobraStage.value = 'idle'
        else if (kobraStage.value === 'committing') {
          kobraStage.value = 'awaiting-reconcile'
          kobraUnknownNotice.value =
            describeBackendError(outcome.code) ??
            describeConfigurationError(outcome.code)
          persistPendingOperation(opContext, 'awaiting-reconcile')
        }
        await nextTick()
        kobraErrorSummary.value?.focus()
        return
      }
    }
  }

  async function commitKobraX() {
    const opContext = kobraOperation.value
    if (
      kobraBusy.value ||
      kobraStage.value !== 'prepared' ||
      !kobraCommitConfirmed.value ||
      !opContext?.preparedReceiptSha256
    )
      return
    const token = epoch.generation()
    const opController = new AbortController()
    epoch.setController(opController)
    kobraBusy.value = true
    kobraError.value = ''
    kobraStage.value = 'committing'
    persistPendingOperation(opContext, 'awaiting-reconcile')
    kobraStatus.value =
      'Confirmando atribuição no Connector e reconciliando recibo assinado no inventário…'
    try {
      const session = await ensureKobraSession(opController.signal)
      if (token !== epoch.generation()) return
      const outcome = await session.commit({
        operationId: opContext.operationId,
        target: opContext.target,
        targetSha256: opContext.targetSha256,
        preparedReceiptSha256: opContext.preparedReceiptSha256,
        expectedRevision: opContext.expectedRevision,
        signal: opController.signal,
      })
      await applySessionOutcome(outcome, opContext, token, opController.signal)
    } catch (cause) {
      await handleKobraException(cause, opContext, token, true)
    } finally {
      if (token === epoch.generation()) kobraBusy.value = false
    }
  }

  async function reconcileKobraX() {
    const opContext = kobraOperation.value
    if (kobraBusy.value || !opContext) return
    const token = epoch.generation()
    const opController = new AbortController()
    epoch.setController(opController)
    kobraBusy.value = true
    kobraError.value = ''
    kobraStatus.value =
      'Consultando estado durável da operação no Connector e reconciliando inventário…'
    try {
      if (state.kobraBootstrap.value.kind !== 'ready') {
        await loadKobraBootstrap(token, opController.signal)
      }
      if (token !== epoch.generation()) return
      const session = await ensureKobraSession(opController.signal)
      if (token !== epoch.generation()) return
      const outcome = await session.reconcile({
        operationId: opContext.operationId,
        target: opContext.target,
        targetSha256: opContext.targetSha256,
        expectedRevision: opContext.expectedRevision,
        signal: opController.signal,
      })
      await applySessionOutcome(outcome, opContext, token, opController.signal)
    } catch (cause) {
      await handleKobraException(cause, opContext, token, true)
    } finally {
      if (token === epoch.generation()) kobraBusy.value = false
    }
  }

  async function cancelKobraX() {
    const opContext = kobraOperation.value
    if (kobraBusy.value || !opContext) return
    const token = epoch.generation()
    const opController = new AbortController()
    epoch.setController(opController)
    kobraBusy.value = true
    kobraError.value = ''
    kobraStatus.value = 'Solicitando cancelamento da operação no Connector…'
    try {
      const session = await ensureKobraSession(opController.signal)
      if (token !== epoch.generation()) return
      const outcome = await session.cancel({
        operationId: opContext.operationId,
        target: opContext.target,
        targetSha256: opContext.targetSha256,
        expectedRevision: opContext.expectedRevision,
        signal: opController.signal,
      })
      await applySessionOutcome(outcome, opContext, token, opController.signal)
    } catch {
      if (token !== epoch.generation()) return
      closeKobraSession()
      kobraStage.value = 'awaiting-reconcile'
      kobraUnknownNotice.value =
        'Não foi possível confirmar o cancelamento remoto no Connector.'
      kobraError.value =
        'A sessão local foi encerrada, mas isso não confirma que o Connector desfez alterações remotas. Consulte o estado da operação antes de tentar novamente.'
      await nextTick()
      kobraErrorSummary.value?.focus()
    } finally {
      if (token === epoch.generation()) kobraBusy.value = false
    }
  }

  return { applySessionOutcome, commitKobraX, reconcileKobraX, cancelKobraX }
}
