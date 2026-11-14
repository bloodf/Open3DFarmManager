<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
} from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import type { SignedConfigurationReceipt } from '../../../../packages/farm-protocol/src/configuration-receipt.ts'
import {
  configurationTargetHash,
  type ConfigurationTarget,
} from '../../../../packages/farm-protocol/src/configuration-target.ts'
import { listenForAuthInvalidation } from '../utils/auth-invalidation.ts'
import { readBrowserDeviceScope } from '../utils/browser-device-enrollment.ts'
import { listDeviceKeys, type LocalDeviceKey } from '../utils/device-key.ts'
import {
  observationAge,
  printerStateLabel,
  type FarmHealth,
  type FarmObservation,
  type FarmSnapshot,
} from '../utils/farm-view.ts'
import {
  KOBRA_X_DEVICE_CAPABILITIES,
  describeConfigurationError,
  describeRecoveryReason,
  describeUnknownReason,
  isKobraXAssignment,
  openConfigurationBrowserSession,
  readConfigurationBootstrap,
  validateKobraXTargetInput,
  type ConfigurationBrowserSession,
  type ConfigurationSessionOutcome,
  type LoadedConfigurationBootstrap,
} from '../utils/kobralink-onboarding.ts'
import { createAuthenticatedFarmStatusFeed } from '../utils/webrtc/farm-status-feed.ts'
import { createFarmStatusKeyResolver } from '../utils/webrtc/farm-status-key-resolver.ts'

type Printer = {
  assignmentId: string
  agentId: string
  printerKey: string
  status: 'active' | 'revoked'
  connectorStatus: 'pending' | 'approved' | 'revoked'
}

type BrowserKeyChoice = {
  keyId: string
  thumbprint: string
  localKey: LocalDeviceKey
}

type KobraKeyState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | {
      kind: 'unavailable'
      reason:
        | 'storage'
        | 'registry'
        | 'incomplete'
        | 'missing'
        | 'pending'
        | 'revoked'
    }
  | {
      kind: 'available'
      accountId: string
      choices: readonly BrowserKeyChoice[]
    }

type KobraBootstrapState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'ready'; data: LoadedConfigurationBootstrap }

type KobraOperationContext = {
  accountId: string
  operationId: string
  farmId: string
  agentId: string
  keyId: string
  target: ConfigurationTarget
  targetSha256: string
  expectedRevision: number
  displayLabel: string
  preparedReceipt: SignedConfigurationReceipt | null
  preparedReceiptSha256: string | null
}

const PENDING_OP_SESSION_KEY = 'openfarm:kobra-x-pending-op'

const farms = ref<{ farmId: string }[]>([]),
  farmId = ref(''),
  printers = ref<Printer[]>([]),
  connectors = ref<{ agentId: string; fingerprint: string; status: string }[]>(
    [],
  )
const nextFarm = ref<string | null>(null),
  nextPrinter = ref<string | null>(null),
  nextConnector = ref<string | null>(null)
const canManage = ref(false),
  pending = ref(false),
  error = ref(''),
  message = ref(''),
  agentId = ref(''),
  printerKey = ref(''),
  confirmed = ref(false),
  revokeTarget = ref<Printer | null>(null),
  revokeConfirmed = ref(false)
const heading = ref<HTMLElement | null>(null),
  errorSummary = ref<HTMLElement | null>(null),
  kobraErrorSummary = ref<HTMLElement | null>(null)

// Kobra X onboarding state
const kobraAgentId = ref(''),
  kobraKeyId = ref(''),
  kobraKeyState = shallowRef<KobraKeyState>({ kind: 'idle' }),
  kobraBootstrap = shallowRef<KobraBootstrapState>({ kind: 'idle' }),
  kobraIp = ref(''),
  kobraLabel = ref(''),
  kobraExpectedDeviceId = ref(''),
  kobraBusy = ref(false),
  kobraError = ref(''),
  kobraStatus = ref(''),
  kobraStage = ref<
    | 'idle'
    | 'preparing'
    | 'prepared'
    | 'committing'
    | 'awaiting-reconcile'
    | 'recovery-required'
    | 'confirmed'
  >('idle'),
  kobraCommitConfirmed = ref(false),
  kobraUnknownNotice = ref(''),
  kobraRecoveryReason = ref<string | null>(null)

const kobraOperation = shallowRef<KobraOperationContext | null>(null)
const kobraPrepared = shallowRef<Extract<
  ConfigurationSessionOutcome,
  { kind: 'prepared' }
> | null>(null)
const kobraConfirmed = shallowRef<Extract<
  ConfigurationSessionOutcome,
  { kind: 'inventory-confirmed' }
> | null>(null)
const kobraDisplayLabels = ref<Record<string, string>>({})

// Live WebRTC read-only status for active assignments on this page
const liveConnections = ref<
  Record<
    string,
    'unavailable' | 'connecting' | 'verifying' | 'authenticated' | 'closed'
  >
>({})
const liveObservations = shallowRef<Record<string, FarmObservation>>({})
const liveTick = ref({ wall: Date.now(), mono: performance.now() })

let generation = 0,
  controller: AbortController | undefined,
  kobraGeneration = 0,
  kobraController: AbortController | undefined,
  kobraSession: ConfigurationBrowserSession | undefined,
  feedHandles: { close(): void }[] = [],
  feedController: AbortController | undefined,
  tickTimer: ReturnType<typeof setInterval> | undefined,
  stopAuthInvalidation: (() => void) | undefined

const selectedKobraKey = computed(() => {
  const state = kobraKeyState.value
  if (state.kind !== 'available') return null
  return state.choices.find((c) => c.keyId === kobraKeyId.value) ?? null
})

const kobraKeyMessage = computed(() => {
  const state = kobraKeyState.value
  if (state.kind === 'idle' || state.kind === 'available') return ''
  if (state.kind === 'loading')
    return 'Consultando dispositivos aprovados deste navegador…'
  switch (state.reason) {
    case 'storage':
      return 'Não foi possível acessar as chaves salvas neste navegador (IndexedDB/WebCrypto).'
    case 'registry':
      return 'Não foi possível confirmar a aprovação dos dispositivos deste navegador.'
    case 'incomplete':
      return 'A consulta dos dispositivos deste navegador ficou incompleta.'
    case 'pending':
      return 'A chave deste navegador aguarda aprovação de proprietário ou administrador.'
    case 'revoked':
      return 'A chave deste navegador foi revogada. Cadastre e aprove uma nova chave.'
    case 'missing':
      return 'Nenhuma chave local aprovada para esta conta e farm neste navegador.'
  }
})

function persistPendingOperation(
  op: KobraOperationContext | null,
  stage: typeof kobraStage.value,
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
        target: op.target,
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

function closeLiveFeeds() {
  feedController?.abort()
  feedController = undefined
  for (const handle of feedHandles.splice(0)) {
    try {
      handle.close()
    } catch {}
  }
  liveConnections.value = {}
}

function closeKobraSession() {
  const active = kobraSession
  kobraSession = undefined
  if (active) {
    active.close()
    void active.dispose()
  }
}

function clearKobraContext(
  preserveSelection = false,
  preserveUnresolvedOp = false,
) {
  kobraGeneration++
  kobraController?.abort()
  kobraController = undefined
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

function startLiveStatusFeed() {
  closeLiveFeeds()
  const currentFarm = farmId.value
  const keyState = kobraKeyState.value
  const keyChoice = selectedKobraKey.value
  if (!currentFarm || keyState.kind !== 'available' || !keyChoice) return
  const activePrinters = printers.value.filter(
    (p) => p.status === 'active' && p.connectorStatus === 'approved',
  )
  if (!activePrinters.length) return
  const byAgent = new Map<string, Printer[]>()
  for (const printer of activePrinters) {
    const group = byAgent.get(printer.agentId) ?? []
    group.push(printer)
    byAgent.set(printer.agentId, group)
  }
  const currentController = new AbortController()
  feedController = currentController
  const accountId = keyState.accountId
  const viewEpoch = kobraGeneration
  const feed = createAuthenticatedFarmStatusFeed({
    resolveKey: createFarmStatusKeyResolver({
      isCurrent(scope, keyId) {
        return (
          !currentController.signal.aborted &&
          farmId.value === scope.farmId &&
          kobraKeyState.value.kind === 'available' &&
          kobraKeyState.value.accountId === scope.accountId &&
          kobraKeyId.value === keyId &&
          scope.viewEpoch === viewEpoch
        )
      },
    }),
  })
  for (const [targetAgentId, group] of byAgent.entries()) {
    const setAgentConnection = (
      status:
        'unavailable' | 'connecting' | 'verifying' | 'authenticated' | 'closed',
    ) => {
      const next = { ...liveConnections.value }
      for (const item of group) next[item.assignmentId] = status
      liveConnections.value = next
    }
    setAgentConnection('connecting')
    const handle = feed.open({
      scope: { accountId, farmId: currentFarm, viewEpoch },
      agentId: targetAgentId,
      assignmentRefs: group.map((p) => ({
        assignmentId: p.assignmentId,
        agentId: p.agentId,
        printerKey: p.printerKey,
      })),
      browserKeyId: keyChoice.keyId,
      signal: currentController.signal,
      onHealth(health: FarmHealth) {
        if (currentController.signal.aborted) return
        if (health.kind === 'connecting' || health.kind === 'verifying') {
          setAgentConnection(health.kind)
        } else if (health.kind === 'authenticated') {
          setAgentConnection('authenticated')
        } else {
          setAgentConnection('closed')
          const nextObs = { ...liveObservations.value }
          for (const item of group) {
            const existing = nextObs[item.assignmentId]
            if (existing)
              nextObs[item.assignmentId] = { ...existing, historical: true }
          }
          liveObservations.value = nextObs
        }
      },
      onSnapshot(snapshot: FarmSnapshot) {
        if (currentController.signal.aborted) return
        const nextObs = { ...liveObservations.value }
        for (const item of group) {
          const found = snapshot.message.printers.find(
            (p) => p.printerKey === item.printerKey,
          )
          if (found) {
            nextObs[item.assignmentId] = {
              state: found,
              received: {
                wall: snapshot.receivedAtWallMs,
                mono: snapshot.receivedAtMonoMs,
              },
              sourceClockComparable: snapshot.sourceClockComparable,
              historical: false,
            }
          }
        }
        liveObservations.value = nextObs
      },
    })
    feedHandles.push(handle)
  }
}

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
    if (token === kobraGeneration) {
      kobraKeyState.value = { kind: 'unavailable', reason: 'registry' }
    }
    return
  }
  if (token !== kobraGeneration || farmId.value !== selectedFarm) return
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
    if (token === kobraGeneration) {
      kobraKeyState.value = { kind: 'unavailable', reason: 'storage' }
    }
    return
  }
  let verifyPage
  try {
    verifyPage = await readBrowserDeviceScope(selectedFarm, signal)
  } catch {
    if (token === kobraGeneration) {
      kobraKeyState.value = { kind: 'unavailable', reason: 'registry' }
    }
    return
  }
  if (token !== kobraGeneration || farmId.value !== selectedFarm) return
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
    if (token !== kobraGeneration) return
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
    if (token !== kobraGeneration) return
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
  const currentFarm = farmId.value
  clearKobraContext(true, preserveUnresolvedOp)
  closeLiveFeeds()
  if (!currentFarm || !canManage.value) return
  const token = kobraGeneration
  const currentController = new AbortController()
  kobraController = currentController
  await loadKobraBrowserKeys(currentFarm, token, currentController.signal)
  if (token !== kobraGeneration) return
  if (preserveUnresolvedOp && kobraAgentId.value && kobraKeyId.value) {
    restorePersistedOperation(currentFarm, kobraAgentId.value, kobraKeyId.value)
  }
  startLiveStatusFeed()
  await loadKobraBootstrap(token, currentController.signal)
}

function onKobraContextChange() {
  clearPersistedOperation()
  void refreshKobraContext(false)
}

async function selectFarm() {
  clear()
  message.value = ''
  if (!farmId.value) return
  await run(async (signal, current) => {
    await loadAssignments(signal, current)
    if (current === generation && canManage.value) {
      await loadConnectors(signal, current)
    }
  })
  if (farmId.value && canManage.value) {
    await refreshKobraContext()
  }
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
  const session = await openConfigurationBrowserSession({
    accountId: keyState.accountId,
    farmId: farmId.value,
    agentId: kobraAgentId.value,
    keyId: keyChoice.keyId,
    localKey: keyChoice.localKey,
    bootstrap: boot.data,
    signal,
  })
  kobraSession = session
  return session
}

async function applySessionOutcome(
  outcome: ConfigurationSessionOutcome,
  opContext: KobraOperationContext,
  token: number,
  signal: AbortSignal,
) {
  if (token !== kobraGeneration) return
  switch (outcome.kind) {
    case 'prepared': {
      kobraOperation.value = {
        ...opContext,
        preparedReceipt: outcome.receipt,
        preparedReceiptSha256: outcome.receiptSha256,
      }
      kobraPrepared.value = outcome
      kobraCommitConfirmed.value = false
      kobraStage.value = 'prepared'
      kobraStatus.value =
        'Identidade da Kobra X observada pelo Connector. Confira os dados e confirme para ativar.'
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
        'Anycubic Kobra X adicionada e confirmada com recibo assinado pelo Connector.'
      await loadAssignments(signal, generation)
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
      kobraError.value = describeConfigurationError(outcome.code)
      if (kobraStage.value === 'preparing') kobraStage.value = 'idle'
      else if (kobraStage.value === 'committing') {
        kobraStage.value = 'awaiting-reconcile'
        kobraUnknownNotice.value = describeConfigurationError(outcome.code)
        persistPendingOperation(opContext, 'awaiting-reconcile')
      }
      await nextTick()
      kobraErrorSummary.value?.focus()
      return
    }
  }
}

async function handleKobraException(
  cause: unknown,
  opContext: KobraOperationContext | null,
  token: number,
  wasMutating: boolean,
) {
  if (token !== kobraGeneration) return
  closeKobraSession()
  const status =
    cause && typeof cause === 'object' && 'statusCode' in cause
      ? Number(cause.statusCode)
      : cause && typeof cause === 'object' && 'status' in cause
        ? Number(cause.status)
        : undefined
  if (status === 401 || status === 403) {
    kobraError.value =
      'Permissão negada ou dispositivo/sessão revogado. Nenhuma confirmação foi concluída.'
    if (wasMutating && opContext) {
      kobraStage.value = 'awaiting-reconcile'
      kobraUnknownNotice.value =
        'Autorização interrompida após o envio. Revalide sua sessão e consulte o estado da operação.'
      persistPendingOperation(opContext, 'awaiting-reconcile')
    } else {
      kobraStage.value = 'idle'
    }
  } else if (status === 409) {
    kobraError.value =
      'Conflito de registro: o recibo conflita com uma atribuição já existente nesta farm.'
    kobraStage.value = opContext ? 'awaiting-reconcile' : 'idle'
  } else if (wasMutating && opContext) {
    kobraStage.value = 'awaiting-reconcile'
    kobraUnknownNotice.value =
      'Tempo esgotado ou conexão WebRTC encerrada antes da confirmação final.'
    persistPendingOperation(opContext, 'awaiting-reconcile')
    kobraError.value =
      'Resultado não confirmado (tempo esgotado ou perda de conexão). Não crie uma nova operação: consulte e reconcilie o estado da operação atual.'
  } else {
    kobraStage.value = 'idle'
    kobraError.value =
      'Não foi possível estabelecer ou concluir a sessão segura config-v1 com o Connector.'
  }
  await nextTick()
  kobraErrorSummary.value?.focus()
}

async function prepareKobraX() {
  if (kobraBusy.value || kobraBootstrap.value.kind !== 'ready') return
  kobraError.value = ''
  kobraStatus.value = ''
  const validated = validateKobraXTargetInput({
    ipv4: kobraIp.value,
    displayLabel: kobraLabel.value,
    expectedDeviceId: kobraExpectedDeviceId.value,
  })
  if (!validated.ok) {
    kobraError.value = validated.error
    await nextTick()
    kobraErrorSummary.value?.focus()
    return
  }
  const expectedRevision = kobraBootstrap.value.data.bootstrap.revision
  if (expectedRevision === null) {
    kobraError.value = 'Configuração não disponível neste Connector.'
    await nextTick()
    kobraErrorSummary.value?.focus()
    return
  }
  const token = kobraGeneration
  const opController = new AbortController()
  kobraController = opController
  kobraBusy.value = true
  kobraStage.value = 'preparing'
  kobraStatus.value =
    'Conectando via WebRTC config-v1 e preparando descoberta na LAN do Connector…'
  let opContext: KobraOperationContext | null = null
  try {
    const targetSha256 = await configurationTargetHash(validated.target)
    if (kobraKeyState.value.kind !== 'available')
      throw new Error('Approved browser key required')
    opContext = {
      accountId: kobraKeyState.value.accountId,
      operationId: crypto.randomUUID(),
      farmId: farmId.value,
      agentId: kobraAgentId.value,
      keyId: kobraKeyId.value,
      target: validated.target,
      targetSha256,
      expectedRevision,
      displayLabel: validated.displayLabel,
      preparedReceipt: null,
      preparedReceiptSha256: null,
    }
    kobraOperation.value = opContext
    persistPendingOperation(opContext, 'awaiting-reconcile')
    const session = await ensureKobraSession(opController.signal)
    if (token !== kobraGeneration) return
    const outcome = await session.prepare({
      operationId: opContext.operationId,
      target: opContext.target,
      expectedRevision: opContext.expectedRevision,
      signal: opController.signal,
    })
    await applySessionOutcome(outcome, opContext, token, opController.signal)
  } catch (cause) {
    await handleKobraException(cause, opContext, token, true)
  } finally {
    if (token === kobraGeneration) kobraBusy.value = false
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
  const token = kobraGeneration
  const opController = new AbortController()
  kobraController = opController
  kobraBusy.value = true
  kobraError.value = ''
  kobraStage.value = 'committing'
  persistPendingOperation(opContext, 'awaiting-reconcile')
  kobraStatus.value =
    'Confirmando atribuição no Connector e reconciliando recibo assinado no inventário…'
  try {
    const session = await ensureKobraSession(opController.signal)
    if (token !== kobraGeneration) return
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
    if (token === kobraGeneration) kobraBusy.value = false
  }
}

async function reconcileKobraX() {
  const opContext = kobraOperation.value
  if (kobraBusy.value || !opContext) return
  const token = kobraGeneration
  const opController = new AbortController()
  kobraController = opController
  kobraBusy.value = true
  kobraError.value = ''
  kobraStatus.value =
    'Consultando estado durável da operação no Connector e reconciliando inventário…'
  try {
    if (kobraBootstrap.value.kind !== 'ready') {
      await loadKobraBootstrap(token, opController.signal)
    }
    if (token !== kobraGeneration) return
    const session = await ensureKobraSession(opController.signal)
    if (token !== kobraGeneration) return
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
    if (token === kobraGeneration) kobraBusy.value = false
  }
}

async function cancelKobraX() {
  const opContext = kobraOperation.value
  if (kobraBusy.value || !opContext) return
  const token = kobraGeneration
  const opController = new AbortController()
  kobraController = opController
  kobraBusy.value = true
  kobraError.value = ''
  kobraStatus.value = 'Solicitando cancelamento da operação no Connector…'
  try {
    const session = await ensureKobraSession(opController.signal)
    if (token !== kobraGeneration) return
    const outcome = await session.cancel({
      operationId: opContext.operationId,
      target: opContext.target,
      targetSha256: opContext.targetSha256,
      expectedRevision: opContext.expectedRevision,
      signal: opController.signal,
    })
    await applySessionOutcome(outcome, opContext, token, opController.signal)
  } catch {
    if (token !== kobraGeneration) return
    closeKobraSession()
    kobraStage.value = 'awaiting-reconcile'
    kobraUnknownNotice.value =
      'Não foi possível confirmar o cancelamento remoto no Connector.'
    kobraError.value =
      'A sessão local foi encerrada, mas isso não confirma que o Connector desfez alterações remotas. Consulte o estado da operação antes de tentar novamente.'
    await nextTick()
    kobraErrorSummary.value?.focus()
  } finally {
    if (token === kobraGeneration) kobraBusy.value = false
  }
}

function abortLocalKobraWait() {
  if (!kobraBusy.value) return
  kobraGeneration++
  kobraController?.abort()
  kobraController = undefined
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
  kobraLabel.value = ''
  kobraExpectedDeviceId.value = ''
}

function liveConnectionLabel(assignmentId: string): string {
  const status = liveConnections.value[assignmentId] ?? 'unavailable'
  const obs = liveObservations.value[assignmentId]
  switch (status) {
    case 'authenticated':
      return obs
        ? 'Conexão direta autenticada'
        : 'Conexão direta autenticada; aguardando estado.'
    case 'connecting':
      return 'Estabelecendo conexão direta…'
    case 'verifying':
      return 'Verificando conexão direta…'
    case 'closed':
      return obs
        ? 'Conexão direta indisponível. Exibindo a última observação.'
        : 'Conexão direta indisponível'
    case 'unavailable':
      return 'Conexão direta indisponível'
  }
}

function livePrinterStateText(assignmentId: string): string {
  void liveTick.value
  const obs = liveObservations.value[assignmentId]
  if (!obs) return 'Nenhum estado recebido'
  const age = observationAge(obs, { wall: Date.now(), mono: performance.now() })
  const label = printerStateLabel[obs.state.state]
  return age.stale ? label + ' (desatualizado)' : label
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

onMounted(() => {
  heading.value?.focus()
  void loadFarms()
  tickTimer = setInterval(() => {
    liveTick.value = { wall: Date.now(), mono: performance.now() }
  }, 1000)
  stopAuthInvalidation = listenForAuthInvalidation(() => {
    clear()
    clearPersistedOperation()
    farms.value = []
    farmId.value = ''
    nextFarm.value = null
    error.value =
      'A conta mudou em outra aba. Entre novamente e atualize a página antes de continuar.'
  })
})

onBeforeUnmount(() => {
  clearInterval(tickTimer)
  stopAuthInvalidation?.()
  clear()
})
onBeforeRouteLeave(clear)
</script>
<template>
  <main id="conteudo">
    <h1 ref="heading" tabindex="-1">Impressoras da farm</h1>
    <nav aria-label="Conta">
      <NuxtLink to="/">Início</NuxtLink> ·
      <NuxtLink to="/farm">Minha farm</NuxtLink> ·
      <NuxtLink to="/connectors">Connectors</NuxtLink> ·
      <NuxtLink to="/parear">Aprovar Connector</NuxtLink> ·
      <NuxtLink to="/dispositivos">Dispositivos do navegador</NuxtLink> ·
      <NuxtLink to="/sair">Sair da conta</NuxtLink>
    </nav>
    <p>
      Consulte as atribuições de impressoras. Sem conexão direta com o
      Connector, o modo degradado é somente leitura para operação: esta página
      não envia comandos de impressão nem acessa câmeras.
    </p>
    <p v-if="error" ref="errorSummary" role="alert" tabindex="-1">
      {{ error }} <NuxtLink to="/entrar">Entrar novamente</NuxtLink>
    </p>
    <p role="status" aria-live="polite">{{ pending ? 'Aguarde.' : message }}</p>
    <label for="printer-farm">Farm</label
    ><select
      id="printer-farm"
      v-model="farmId"
      :disabled="pending"
      @change="selectFarm"
    >
      <option value="">Selecione uma farm</option>
      <option v-for="farm in farms" :key="farm.farmId" :value="farm.farmId">
        {{ farm.farmId }}
      </option>
    </select>
    <button
      v-if="nextFarm"
      type="button"
      :disabled="pending"
      @click="loadFarms(nextFarm)"
    >
      Próximas farms
    </button>
    <section v-if="farmId" aria-labelledby="assignment-heading">
      <h2 id="assignment-heading">Atribuições</h2>
      <p v-if="!pending && !printers.length">
        Nenhuma atribuição nesta página.
      </p>
      <ul>
        <li v-for="printer in printers" :key="printer.assignmentId">
          <dl>
            <dt>Chave exata</dt>
            <dd class="exact-key">{{ printer.printerKey }}</dd>
            <template v-if="kobraDisplayLabels[printer.printerKey]">
              <dt>Apelido local nesta sessão</dt>
              <dd class="exact-key">
                {{ kobraDisplayLabels[printer.printerKey] }}
              </dd>
            </template>
            <dt>Connector</dt>
            <dd>{{ printer.agentId }}</dd>
            <dt>Estado da atribuição</dt>
            <dd>
              {{
                printer.status === 'revoked'
                  ? 'Revogada permanentemente'
                  : 'Ativa'
              }}
            </dd>
            <dt>Autorização atual do Connector</dt>
            <dd>
              {{
                printer.connectorStatus === 'approved'
                  ? 'Aprovado'
                  : printer.connectorStatus === 'revoked'
                    ? 'Revogado, uso indisponível'
                    : 'Pendente, uso indisponível'
              }}
            </dd>
            <template v-if="isKobraXAssignment(printer)">
              <dt>Modelo e qualificação</dt>
              <dd>
                Anycubic Kobra X (qualificação provisória; firmware não
                qualificado — somente leitura)
              </dd>
              <dt>Conexão direta WebRTC</dt>
              <dd>{{ liveConnectionLabel(printer.assignmentId) }}</dd>
              <dt>Último estado informado via WebRTC</dt>
              <dd>
                {{ livePrinterStateText(printer.assignmentId) }}
                <template
                  v-if="
                    liveObservations[printer.assignmentId]?.state.state ===
                    'printing'
                  "
                >
                  ({{
                    Math.round(
                      liveObservations[printer.assignmentId]!.state.progress *
                        100,
                    )
                  }}%)
                </template>
              </dd>
            </template>
          </dl>
          <div
            v-if="isKobraXAssignment(printer)"
            class="capability-box"
            role="region"
            :aria-labelledby="'kobra-cap-' + printer.assignmentId"
          >
            <h3 :id="'kobra-cap-' + printer.assignmentId">
              Capacidades admitidas por dispositivo ({{ printer.printerKey }})
            </h3>
            <dl>
              <div v-for="cap in KOBRA_X_DEVICE_CAPABILITIES" :key="cap.id">
                <dt>{{ cap.label }}</dt>
                <dd>{{ cap.statusText }} — {{ cap.reason }}</dd>
              </div>
            </dl>
          </div>
          <button
            v-if="canManage && printer.status === 'active'"
            type="button"
            :disabled="pending"
            @click="selectRevocation(printer)"
          >
            Revogar atribuição de {{ printer.printerKey }}
          </button>
        </li>
      </ul>
      <button
        v-if="nextPrinter"
        type="button"
        :disabled="pending"
        @click="
          run((signal, current) =>
            loadAssignments(signal, current, nextPrinter),
          )
        "
      >
        Próximas atribuições
      </button>
      <p v-if="!canManage">
        Somente proprietários e administradores podem cadastrar, adicionar uma
        Anycubic Kobra X ou revogar atribuições.
      </p>
    </section>

    <section
      v-if="farmId && canManage"
      aria-labelledby="kobra-x-heading"
      :aria-busy="kobraBusy"
    >
      <h2 id="kobra-x-heading">Adicionar Anycubic Kobra X</h2>
      <p id="kobra-x-intro">
        Adicione sua Anycubic Kobra X aqui no OpenFarm. Ative o
        <strong>Modo LAN</strong> e use a rede local do Connector (porta TCP
        18910). A compatibilidade do modelo, firmware e hardware permanece em
        validação. Este adaptador opera somente em modo de leitura.
      </p>
      <p
        v-if="kobraError"
        ref="kobraErrorSummary"
        role="alert"
        tabindex="-1"
        class="kobra-alert"
      >
        {{ kobraError }}
      </p>
      <p role="status" aria-live="polite">
        {{
          kobraBusy && !kobraStatus ? 'Processando configuração…' : kobraStatus
        }}
      </p>

      <fieldset :disabled="kobraBusy">
        <legend>1. Connector e dispositivo do navegador</legend>
        <label for="kobra-connector">Connector aprovado para a Kobra X</label>
        <select
          id="kobra-connector"
          v-model="kobraAgentId"
          @change="onKobraContextChange"
        >
          <option value="">Selecione um Connector aprovado</option>
          <option
            v-for="connector in connectors"
            :key="connector.agentId"
            :value="connector.agentId"
          >
            {{ connector.agentId }} · {{ connector.fingerprint }}
          </option>
        </select>
        <p v-if="!connectors.length">
          Nenhum Connector aprovado nesta farm. Pareie e aprove um Connector em
          <NuxtLink to="/parear">Aprovar Connector</NuxtLink> ou consulte
          <NuxtLink to="/connectors">Connectors</NuxtLink>.
        </p>

        <template v-if="kobraKeyState.kind === 'available'">
          <label for="kobra-device-key"
            >Dispositivo aprovado deste navegador</label
          >
          <select
            id="kobra-device-key"
            v-model="kobraKeyId"
            @change="onKobraContextChange"
          >
            <option
              v-for="choice in kobraKeyState.choices"
              :key="choice.keyId"
              :value="choice.keyId"
            >
              {{ choice.keyId }} · {{ choice.thumbprint }}
            </option>
          </select>
        </template>
        <p v-else-if="kobraKeyMessage">
          {{ kobraKeyMessage }}
          {{ ' '
          }}<NuxtLink to="/dispositivos"
            >Gerenciar dispositivos do navegador</NuxtLink
          >
        </p>

        <div class="kobra-actions">
          <button
            type="button"
            :disabled="kobraBusy"
            @click="refreshKobraContext(true)"
          >
            Verificar capacidade do Connector
          </button>
        </div>

        <p v-if="kobraBootstrap.kind === 'loading'" role="status">
          Consultando capacidade config-v1 do Connector…
        </p>
        <p v-else-if="kobraBootstrap.kind === 'unavailable'" role="status">
          {{ kobraBootstrap.reason }}
        </p>
        <p
          v-else-if="kobraBootstrap.kind === 'ready'"
          class="exact-key"
          role="status"
        >
          Connector apto (protocolo
          {{ kobraBootstrap.data.bootstrap.protocol }} · revisão
          {{ kobraBootstrap.data.bootstrap.revision }} · impressão digital
          {{ kobraBootstrap.data.bootstrap.connectorFingerprint }}).
        </p>
      </fieldset>

      <form
        v-if="kobraStage === 'idle' || kobraStage === 'preparing'"
        @submit.prevent="prepareKobraX"
      >
        <fieldset :disabled="kobraBusy || kobraBootstrap.kind !== 'ready'">
          <legend>2. Preparar descoberta na rede local (Modo LAN)</legend>
          <label for="kobra-ip">Endereço IPv4 da Kobra X na LAN</label>
          <input
            id="kobra-ip"
            v-model="kobraIp"
            required
            maxlength="15"
            autocomplete="off"
            spellcheck="false"
            aria-describedby="kobra-x-intro kobra-ip-help"
          />
          <p id="kobra-ip-help">
            Informe um IPv4 privado na LAN (ex.: 192.168.1.50).
          </p>
          <label for="kobra-label"
            >Apelido local para identificação (opcional)</label
          >
          <input
            id="kobra-label"
            v-model="kobraLabel"
            maxlength="64"
            autocomplete="off"
            aria-describedby="kobra-label-help"
          />
          <p id="kobra-label-help">
            Apelido opcional com até 64 caracteres visíveis.
          </p>
          <label for="kobra-device-id"
            >Identidade esperada do dispositivo — device_id (opcional)</label
          >
          <input
            id="kobra-device-id"
            v-model="kobraExpectedDeviceId"
            maxlength="64"
            autocomplete="off"
            spellcheck="false"
            aria-describedby="kobra-device-id-help"
          />
          <p id="kobra-device-id-help">
            Se já conhecer a identidade esperada, informe-a para conferência.
          </p>
          <div class="kobra-actions">
            <button
              type="submit"
              :disabled="kobraBusy || kobraBootstrap.kind !== 'ready'"
            >
              {{
                kobraBusy && kobraStage === 'preparing'
                  ? 'Preparando no Connector…'
                  : 'Preparar Anycubic Kobra X'
              }}
            </button>
          </div>
        </fieldset>
      </form>
      <div v-if="kobraBusy" class="kobra-actions">
        <button type="button" @click="abortLocalKobraWait">
          Interromper espera local
        </button>
      </div>

      <section
        v-if="
          (kobraStage === 'prepared' || kobraStage === 'committing') &&
          kobraPrepared
        "
        aria-labelledby="kobra-prepared-heading"
        class="kobra-card"
      >
        <h3 id="kobra-prepared-heading">
          3. Revisar identidade observada e qualificação provisória
        </h3>
        <dl>
          <dt>Operação</dt>
          <dd class="exact-key">{{ kobraPrepared.operationId }}</dd>
          <dt>Identidade estável observada (device_id)</dt>
          <dd class="exact-key">
            {{ kobraPrepared.receipt.observed.device_id }}
          </dd>
          <dt>Instância da ponte no Connector</dt>
          <dd class="exact-key">
            {{ kobraPrepared.receipt.target.bridge_instance_id }}
          </dd>
          <dt>Modelo observado</dt>
          <dd>
            {{
              kobraPrepared.receipt.observed.model ??
              'Modelo não informado pela impressora'
            }}
            — Qualificação provisória (Anycubic Kobra X, provisional: true)
          </dd>
          <dt>Firmware observado</dt>
          <dd>
            <template
              v-if="
                kobraPrepared.receipt.observed.firmware.status === 'observed'
              "
            >
              Versão observada:
              {{ kobraPrepared.receipt.observed.firmware.version }} — suporte
              não qualificado (unqualified; somente leitura)
            </template>
            <template v-else>
              Firmware desconhecido (unknown) — suporte não qualificado
              (unqualified; somente leitura)
            </template>
          </dd>
          <dt>Revisão esperada no Connector</dt>
          <dd>{{ kobraPrepared.expectedRevision }}</dd>
        </dl>
        <h4>Capacidades admitidas para esta Kobra X</h4>
        <dl>
          <div v-for="cap in KOBRA_X_DEVICE_CAPABILITIES" :key="cap.id">
            <dt>{{ cap.label }}</dt>
            <dd>{{ cap.statusText }} — {{ cap.reason }}</dd>
          </div>
        </dl>
        <label class="confirmation">
          <input
            id="kobra-confirm-checkbox"
            v-model="kobraCommitConfirmed"
            type="checkbox"
            :disabled="kobraBusy"
          />
          Conferi a identidade observada ({{
            kobraPrepared.receipt.observed.device_id
          }}), a qualificação provisória de modelo/firmware e que esta Kobra X
          operará somente em leitura.
        </label>
        <div class="kobra-actions">
          <button
            type="button"
            :disabled="kobraBusy || !kobraCommitConfirmed"
            @click="commitKobraX"
          >
            {{
              kobraBusy && kobraStage === 'committing'
                ? 'Confirmando e reconciliando…'
                : 'Confirmar e ativar Kobra X'
            }}
          </button>
          <button type="button" :disabled="kobraBusy" @click="cancelKobraX">
            Cancelar preparação
          </button>
        </div>
      </section>

      <section
        v-if="kobraStage === 'awaiting-reconcile' && kobraOperation"
        aria-labelledby="kobra-reconcile-heading"
        class="kobra-card"
      >
        <h3 id="kobra-reconcile-heading">
          Estado da operação não confirmado — reconciliação segura
        </h3>
        <p>
          Operação:
          <span class="exact-key">{{ kobraOperation.operationId }}</span
          >.
          {{ kobraUnknownNotice }}
        </p>
        <p>
          Para evitar duplicação na ponte local, não envie um novo cadastro
          enquanto esta operação estiver pendente. Consulte o estado durável no
          Connector para retomar ou concluir a confirmação do recibo.
        </p>
        <div class="kobra-actions">
          <button type="button" :disabled="kobraBusy" @click="reconcileKobraX">
            {{
              kobraBusy
                ? 'Consultando Connector…'
                : 'Consultar e reconciliar operação'
            }}
          </button>
          <button type="button" :disabled="kobraBusy" @click="cancelKobraX">
            Solicitar cancelamento no Connector
          </button>
        </div>
      </section>

      <section
        v-if="kobraStage === 'recovery-required' && kobraOperation"
        aria-labelledby="kobra-recovery-heading"
        class="kobra-card"
      >
        <h3 id="kobra-recovery-heading">Recuperação pendente no Connector</h3>
        <p>
          Operação:
          <span class="exact-key">{{ kobraOperation.operationId }}</span
          >. Motivo: {{ describeRecoveryReason(kobraRecoveryReason) }}
        </p>
        <p>
          A ativação automática desta impressora foi bloqueada para proteger as
          impressoras já confirmadas. O encerramento abaixo libera a fila de
          configuração no Connector, mas não confirma a remoção de registros
          ambíguos na ponte local.
        </p>
        <div class="kobra-actions">
          <button type="button" :disabled="kobraBusy" @click="reconcileKobraX">
            Consultar estado da operação
          </button>
          <button type="button" :disabled="kobraBusy" @click="cancelKobraX">
            Encerrar operação pendente no Connector
          </button>
        </div>
      </section>

      <section
        v-if="kobraStage === 'confirmed' && kobraConfirmed"
        aria-labelledby="kobra-confirmed-heading"
        class="kobra-card"
      >
        <h3 id="kobra-confirmed-heading">
          Anycubic Kobra X confirmada e ativa em modo somente leitura
        </h3>
        <dl>
          <dt>Chave canônica atribuída</dt>
          <dd class="exact-key">{{ kobraConfirmed.printerKey }}</dd>
          <dt>ID da atribuição</dt>
          <dd class="exact-key">{{ kobraConfirmed.assignmentId }}</dd>
          <dt>Identidade verificada (device_id)</dt>
          <dd class="exact-key">
            {{ kobraConfirmed.receipt.observed.device_id }}
          </dd>
          <dt>Fase do recibo assinado</dt>
          <dd>{{ kobraConfirmed.receipt.phase }}</dd>
          <dt>Revisão confirmada no Connector</dt>
          <dd>{{ kobraConfirmed.committedRevision }}</dd>
        </dl>
        <div class="kobra-actions">
          <button type="button" @click="resetKobraForm">
            Adicionar outra Kobra X
          </button>
        </div>
      </section>
    </section>

    <section v-if="farmId && canManage" aria-labelledby="register-heading">
      <h2 id="register-heading">Cadastrar atribuição</h2>
      <p id="configuration-help">
        Confira a configuração local do Connector e copie a chave exata. Sua
        confirmação é uma declaração administrativa. O servidor não descobre
        impressoras nem verifica a configuração local. Não informe endereço de
        rede ou G-code.
      </p>
      <form @submit.prevent="register">
        <fieldset :disabled="pending">
          <legend>Configuração confirmada localmente</legend>
          <label for="printer-agent">Connector aprovado</label
          ><select id="printer-agent" v-model="agentId" required>
            <option value="">Selecione um Connector aprovado</option>
            <option
              v-for="connector in connectors"
              :key="connector.agentId"
              :value="connector.agentId"
            >
              {{ connector.agentId }} · {{ connector.fingerprint }}
            </option></select
          ><button
            v-if="nextConnector"
            type="button"
            @click="
              run((signal, current) =>
                loadConnectors(signal, current, nextConnector),
              )
            "
          >
            Próximos Connectors
          </button>
          <p v-if="!connectors.length">
            Nenhum Connector aprovado nesta página.
          </p>
          <label for="printer-key">Chave exata da impressora</label
          ><input
            id="printer-key"
            v-model="printerKey"
            required
            maxlength="128"
            autocomplete="off"
            aria-describedby="configuration-help key-help"
          />
          <p id="key-help">
            De 1 a 128 unidades UTF-16, sem alterar espaços, maiúsculas ou
            acentos.
          </p>
          <label
            ><input v-model="confirmed" type="checkbox" required /> Conferi que
            esta chave exata está configurada localmente neste Connector.</label
          ><button
            type="submit"
            :disabled="!confirmed || !agentId || !printerKey"
          >
            Cadastrar atribuição
          </button>
        </fieldset>
      </form>
      <p>
        Revogar é permanente. Para reatribuir uma chave, revogue a atribuição
        atual e cadastre uma nova. O novo cadastro pode falhar; nenhuma
        atribuição anterior será restaurada.
      </p>
    </section>
    <section v-if="revokeTarget" aria-labelledby="revoke-heading">
      <h2 id="revoke-heading">Confirmar revogação permanente</h2>
      <p>
        Chave: <span class="exact-key">{{ revokeTarget.printerKey }}</span
        >. Connector: {{ revokeTarget.agentId }}.
      </p>
      <label
        ><input v-model="revokeConfirmed" type="checkbox" :disabled="pending" />
        Conferi esta atribuição e quero revogá-la permanentemente.</label
      ><button
        type="button"
        :disabled="pending || !revokeConfirmed"
        @click="revoke"
      >
        Confirmar revogação</button
      ><button type="button" :disabled="pending" @click="cancelRevocation">
        Cancelar revogação
      </button>
    </section>
  </main>
</template>
<style scoped>
main {
  max-width: 58rem;
  margin: 2rem auto;
  padding: 0 1rem;
  line-height: 1.6;
}
section {
  margin-block: 2rem;
}
label,
select,
input:not([type='checkbox']),
button {
  display: block;
  margin-block: 0.6rem;
}
input,
select,
button {
  font: inherit;
  max-width: 100%;
  min-height: 2.75rem;
}
input:not([type='checkbox']),
select {
  width: 100%;
  min-width: 0;
  padding: 0.5rem 0.65rem;
}
button {
  padding: 0.5rem 0.75rem;
  cursor: pointer;
}
button:disabled {
  cursor: not-allowed;
}
dd,
dt,
p,
li {
  overflow-wrap: anywhere;
  min-width: 0;
}
.exact-key {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
fieldset {
  padding: 1rem;
  margin-block: 1rem;
  min-width: 0;
}
.kobra-card,
.capability-box {
  border: 1px solid currentColor;
  padding: 1rem;
  margin-block: 1rem;
  min-width: 0;
}
.kobra-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1rem;
  align-items: center;
}
.confirmation {
  display: flex;
  gap: 0.65rem;
  align-items: flex-start;
  min-height: 2.75rem;
}
.confirmation input[type='checkbox'] {
  flex: 0 0 auto;
  width: 1.25rem;
  height: 1.25rem;
  margin-top: 0.25rem;
}
:focus-visible {
  outline: 3px solid #155e75;
  outline-offset: 3px;
}
@media (max-width: 400px) {
  main {
    padding-inline: 0.75rem;
  }
  fieldset,
  .kobra-card,
  .capability-box {
    padding: 0.75rem;
  }
}
</style>
