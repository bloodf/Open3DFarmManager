import { computed, inject, ref, shallowRef, type InjectionKey } from 'vue'
import type { DiscoveryResult } from '../../../../packages/farm-protocol/src/configuration-discovery.ts'
import type { SignedConfigurationReceipt } from '../../../../packages/farm-protocol/src/configuration-receipt.ts'
import type { ConfigurationTarget } from '../../../../packages/farm-protocol/src/configuration-target.ts'
import { describeAnycubicTarget } from './anycubic-onboarding.ts'
import type { LocalDeviceKey } from './device-key.ts'
import type { FarmObservation } from './farm-view.ts'
import type {
  ConfigurationSessionOutcome,
  LoadedConfigurationBootstrap,
} from './kobralink-onboarding.ts'

export type Printer = {
  assignmentId: string
  agentId: string
  printerKey: string
  status: 'active' | 'revoked'
  connectorStatus: 'pending' | 'approved' | 'revoked'
}

export type BrowserKeyChoice = {
  keyId: string
  thumbprint: string
  localKey: LocalDeviceKey
}

export type KobraKeyState =
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

export type KobraBootstrapState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'ready'; data: LoadedConfigurationBootstrap }

export type KobraOperationContext = {
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

export type DiscoveredPrinter = Extract<
  DiscoveryResult,
  { ok: true }
>['printers'][number]
export type LiveConnection =
  'unavailable' | 'connecting' | 'verifying' | 'authenticated' | 'closed'
export type KobraStage =
  | 'idle'
  | 'preparing'
  | 'prepared'
  | 'committing'
  | 'awaiting-reconcile'
  | 'recovery-required'
  | 'confirmed'
export type OnboardingFamily =
  | 'anycubic-lan'
  | 'anycubic-kobra-x'
  | 'klipper-moonraker'
  | 'bambu-lan'
  | 'creality-native'

// Generation counter and controller stay owned by the page so its setup
// functions keep reading them as plain variables.
export type KobraEpoch = {
  generation(): number
  next(): number
  controller(): AbortController | undefined
  setController(controller: AbortController | undefined): void
}

export function createPrinterSetupState() {
  const farms = ref<{ farmId: string }[]>([]),
    farmId = ref(''),
    printers = ref<Printer[]>([]),
    connectors = ref<
      { agentId: string; fingerprint: string; status: string }[]
    >([])
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

  const discoveryPrinters = ref<DiscoveredPrinter[]>([])
  const discoveryMessage = ref('')
  const discoveryBusy = ref(false)
  const probeHost = ref('')
  const onboardingFamily = ref<OnboardingFamily>('anycubic-kobra-x')
  const anycubicHost = ref('')
  const anycubicPort = ref(9883)
  const anycubicModelId = ref('')
  const anycubicDeviceId = ref('')
  const anycubicUsername = ref('')
  const anycubicPassword = ref('')
  const anycubicCaFile = ref('')
  const anycubicPin = ref('')
  const crealityHost = ref('')
  const bambuIp = ref('')
  const bambuSerial = ref('')
  const bambuAccessCode = ref('')
  const bambuControl = ref(false)
  const moonrakerOrigin = ref('')
  const moonrakerApiKey = ref('')
  const moonrakerUsername = ref('')
  const moonrakerPassword = ref('')
  // Signed configuration onboarding state
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
    kobraStage = ref<KobraStage>('idle'),
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
  const liveConnections = ref<Record<string, LiveConnection>>({})
  const liveObservations = shallowRef<Record<string, FarmObservation>>({})
  const liveTick = ref({ wall: Date.now(), mono: performance.now() })

  const anycubicTargetView = computed(() =>
    kobraOperation.value?.target.backend === 'anycubic'
      ? describeAnycubicTarget(kobraOperation.value.target)
      : null,
  )
  const onboarding = (backend: string, family: OnboardingFamily) =>
    computed(
      () =>
        kobraOperation.value?.target.backend === backend ||
        (kobraStage.value === 'idle' && onboardingFamily.value === family),
    )
  const isAnycubicOnboarding = onboarding('anycubic', 'anycubic-lan')
  const isCrealityOnboarding = onboarding('creality', 'creality-native')
  const isBambuOnboarding = onboarding('bambu', 'bambu-lan')
  const isMoonrakerOnboarding = onboarding('moonraker', 'klipper-moonraker')
  const onboardingFamilyLabel = computed(() =>
    isAnycubicOnboarding.value
      ? 'Anycubic (LAN)'
      : isMoonrakerOnboarding.value
        ? 'Klipper / Moonraker'
        : isBambuOnboarding.value
          ? 'Bambu Lab (LAN)'
          : isCrealityOnboarding.value
            ? 'Creality (firmware original)'
            : 'Anycubic Kobra X',
  )
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

  return {
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
    heading,
    errorSummary,
    kobraErrorSummary,
    discoveryPrinters,
    discoveryMessage,
    discoveryBusy,
    probeHost,
    onboardingFamily,
    anycubicHost,
    anycubicPort,
    anycubicModelId,
    anycubicDeviceId,
    anycubicUsername,
    anycubicPassword,
    anycubicCaFile,
    anycubicPin,
    crealityHost,
    bambuIp,
    bambuSerial,
    bambuAccessCode,
    bambuControl,
    moonrakerOrigin,
    moonrakerApiKey,
    moonrakerUsername,
    moonrakerPassword,
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
    kobraDisplayLabels,
    liveConnections,
    liveObservations,
    liveTick,
    anycubicTargetView,
    isAnycubicOnboarding,
    isCrealityOnboarding,
    isBambuOnboarding,
    isMoonrakerOnboarding,
    onboardingFamilyLabel,
    selectedKobraKey,
    kobraKeyMessage,
  }
}

export type PrinterSetupRefs = ReturnType<typeof createPrinterSetupState>
export const printerSetupKey: InjectionKey<PrinterSetupRefs> =
  Symbol('printer-setup')

export function usePrinterSetup(): PrinterSetupRefs {
  const view = inject(printerSetupKey)
  if (!view) throw new Error('Printer setup state was not provided')
  return view
}
