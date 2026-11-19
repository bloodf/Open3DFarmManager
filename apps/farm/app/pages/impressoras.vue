<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, provide } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { configurationTargetHash } from '../../../../packages/farm-protocol/src/configuration-target.ts'
import AssignmentList from '../components/printer-setup/AssignmentList.vue'
import ConnectorContext from '../components/printer-setup/ConnectorContext.vue'
import DiscoveryPanel from '../components/printer-setup/DiscoveryPanel.vue'
import OperationStatus from '../components/printer-setup/OperationStatus.vue'
import PreparedReview from '../components/printer-setup/PreparedReview.vue'
import PrintersFarmSelector from '../components/printer-setup/PrintersFarmSelector.vue'
import PrintersNavIntro from '../components/printer-setup/PrintersNavIntro.vue'
import RegisterAssignment from '../components/printer-setup/RegisterAssignment.vue'
import RevokeConfirmation from '../components/printer-setup/RevokeConfirmation.vue'
import SetupForm from '../components/printer-setup/SetupForm.vue'
import {
  validateAnycubicTargetInput,
  withoutAnycubicCredentials,
} from '../utils/anycubic-onboarding.ts'
import {
  validateBambuTargetInput,
  withoutBambuAccessCode,
} from '../utils/bambu-onboarding.ts'
import { validateCrealityTargetInput } from '../utils/creality-onboarding.ts'
import {
  buildKobraCertTargetOption,
  sanitizeTargetForClientStorage,
} from '../utils/kobra-client-cert-ui.ts'
import { gateKobraXSetup } from '../utils/kobra-x-setup-mode.ts'
import { validateKobraXTargetInput } from '../utils/kobralink-onboarding.ts'
import {
  validateMoonrakerTargetInput,
  withoutMoonrakerKey,
} from '../utils/moonraker-onboarding.ts'
import { openPrinterDiscoverySession } from '../utils/printer-discovery-view-session.ts'
import { printerSetupActionsKey } from '../utils/printer-setup-actions.ts'
import { createPrinterSetup } from '../utils/printer-setup.ts'
import {
  createPrinterSetupState,
  printerSetupKey,
  type KobraEpoch,
  type KobraOperationContext,
} from '../utils/printer-setup-state.ts'

const state = createPrinterSetupState()
const { farmId, canManage, pending, error, message } = state
const { heading, errorSummary, kobraErrorSummary, revokeTarget } = state
const { kobraBusy, kobraBootstrap, kobraError, kobraStatus, kobraStage } = state
const { kobraKeyState, kobraAgentId, kobraKeyId, kobraOperation } = state
const { kobraIp, kobraLabel, kobraExpectedDeviceId, kobraUnknownNotice } = state
const { kobraCertSource, kobraCertInstallPath, kobraCertError } = state
const { kobraCertInline, clearKobraClientCert, kobraSetupMode } = state
const { onboardingFamily, anycubicHost, anycubicPort, anycubicModelId } = state
const { anycubicDeviceId, anycubicUsername, anycubicPassword } = state
const { anycubicCaFile, anycubicPin, crealityHost } = state
const { bambuIp, bambuSerial, bambuAccessCode, bambuControl } = state
const { moonrakerOrigin, moonrakerApiKey } = state
const { moonrakerUsername, moonrakerPassword } = state

// The generation and controller stay plain variables; setup modules read them through epoch.
let kobraGeneration = 0
let kobraController: AbortController | undefined
const epoch: KobraEpoch = {
  generation: () => kobraGeneration,
  next: () => ++kobraGeneration,
  controller: () => kobraController,
  setController: (controller) => (kobraController = controller),
}
const setup = createPrinterSetup(state, epoch, {
  handleKobraException,
  openPrinterDiscoverySession,
})
const { closeKobraSession, ensureKobraSession, applySessionOutcome } = setup
const { persistPendingOperation, clearPersistedOperation } = setup
const prepareSelected = () =>
  ({
    'anycubic-lan': prepareAnycubicPrinter,
    'anycubic-kobra-x': prepareKobraX,
    'bambu-lan': prepareBambuPrinter,
    'creality-native': prepareCrealityPrinter,
    'klipper-moonraker': () =>
      prepareMoonrakerPrinter({
        username: moonrakerUsername.value,
        password: moonrakerPassword.value,
        clear: () => {
          moonrakerUsername.value = ''
          moonrakerPassword.value = ''
        },
      }),
  })[onboardingFamily.value]()
provide(printerSetupKey, state)
provide(printerSetupActionsKey, {
  ...setup,
  prepareSelected,
  selectCrealityMoonraker,
})

function selectCrealityMoonraker() {
  closeKobraSession()
  onboardingFamily.value = 'klipper-moonraker'
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
  const gate = gateKobraXSetup(kobraSetupMode.value)
  const certOption = !gate.ok
    ? gate
    : typeof buildKobraCertTargetOption === 'function' &&
        typeof kobraCertSource !== 'undefined'
      ? buildKobraCertTargetOption({
          source: kobraCertSource.value,
          installPath: kobraCertInstallPath.value,
          inlinePayload: kobraCertInline.value,
          certError: kobraCertError.value,
        })
      : { ok: true as const, clientCertificate: undefined }
  if (!certOption.ok) {
    kobraError.value = certOption.error
    await nextTick()
    kobraErrorSummary.value?.focus()
    return
  }
  const validated = validateKobraXTargetInput({
    ipv4: kobraIp.value,
    displayLabel: kobraLabel.value,
    expectedDeviceId: kobraExpectedDeviceId.value,
    ...(certOption.clientCertificate
      ? { clientCertificate: certOption.clientCertificate }
      : {}),
  })
  const expectedRevision = kobraBootstrap.value.data.bootstrap.revision
  if (!validated.ok || expectedRevision === null) {
    kobraError.value = validated.ok
      ? 'Configuração não disponível neste Connector.'
      : validated.error
    await nextTick()
    kobraErrorSummary.value?.focus()
    return
  }
  const token = kobraGeneration
  const opController = (kobraController = new AbortController())
  kobraBusy.value = true
  kobraStage.value = 'preparing'
  kobraStatus.value =
    'Conectando via WebRTC config-v1 e preparando descoberta na LAN do Connector…'
  let opContext: KobraOperationContext | null = null
  try {
    const targetSha256 = await configurationTargetHash(validated.target)
    if (kobraKeyState.value.kind !== 'available')
      throw new Error('Approved browser key required')
    if (token !== kobraGeneration || opController.signal.aborted) return
    const safeTarget =
      typeof sanitizeTargetForClientStorage === 'function'
        ? sanitizeTargetForClientStorage(validated.target)
        : validated.target
    const candidate: KobraOperationContext = {
      accountId: kobraKeyState.value.accountId,
      operationId: crypto.randomUUID(),
      farmId: farmId.value,
      agentId: kobraAgentId.value,
      keyId: kobraKeyId.value,
      target: safeTarget,
      targetSha256,
      expectedRevision,
      displayLabel: validated.displayLabel,
      preparedReceipt: null,
      preparedReceiptSha256: null,
    }
    const session = await ensureKobraSession(opController.signal)
    if (token !== kobraGeneration) return
    const outcome = await session.prepare({
      operationId: candidate.operationId,
      target: validated.target,
      expectedRevision: candidate.expectedRevision,
      signal: opController.signal,
      beforeDispatch: () => {
        if (token !== kobraGeneration || opController.signal.aborted)
          throw new Error('Configuration context changed before dispatch')
        if (typeof clearKobraClientCert === 'function') clearKobraClientCert()
        persistPendingOperation(candidate, 'awaiting-reconcile')
        opContext = candidate
        kobraOperation.value = candidate
      },
    })
    await applySessionOutcome(outcome, candidate, token, opController.signal)
  } catch (cause) {
    await handleKobraException(cause, opContext, token, opContext !== null)
  } finally {
    if (token === kobraGeneration) kobraBusy.value = false
  }
}

async function prepareMoonrakerPrinter(
  login: { username?: string; password?: string; clear?: () => void } = {},
) {
  if (kobraBusy.value || kobraBootstrap.value.kind !== 'ready') return
  kobraError.value = ''
  kobraStatus.value = ''
  const validated = validateMoonrakerTargetInput({
    origin: moonrakerOrigin.value,
    apiKey: moonrakerApiKey.value,
    username: login.username,
    password: login.password,
    displayLabel: kobraLabel.value,
  })
  const expectedRevision = kobraBootstrap.value.data.bootstrap.revision
  if (!validated.ok || expectedRevision === null) {
    kobraError.value = validated.ok
      ? 'Configuração não disponível neste Connector.'
      : validated.error
    await nextTick()
    kobraErrorSummary.value?.focus()
    return
  }
  const token = kobraGeneration
  const opController = (kobraController = new AbortController())
  kobraBusy.value = true
  kobraStage.value = 'preparing'
  kobraStatus.value =
    'Conectando via WebRTC config-v1 e preparando descoberta na LAN do Connector…'
  let opContext: KobraOperationContext | null = null
  try {
    const targetSha256 = await configurationTargetHash(validated.target)
    if (kobraKeyState.value.kind !== 'available')
      throw new Error('Approved browser key required')
    if (token !== kobraGeneration || opController.signal.aborted) return
    const candidate: KobraOperationContext = {
      accountId: kobraKeyState.value.accountId,
      operationId: crypto.randomUUID(),
      farmId: farmId.value,
      agentId: kobraAgentId.value,
      keyId: kobraKeyId.value,
      target:
        validated.target.backend === 'moonraker'
          ? withoutMoonrakerKey(validated.target)
          : validated.target,
      targetSha256,
      expectedRevision,
      displayLabel: validated.displayLabel,
      preparedReceipt: null,
      preparedReceiptSha256: null,
    }
    const session = await ensureKobraSession(opController.signal)
    if (token !== kobraGeneration) return
    const outcome = await session.prepare({
      operationId: candidate.operationId,
      target: validated.target,
      expectedRevision: candidate.expectedRevision,
      signal: opController.signal,
      beforeDispatch: () => {
        if (token !== kobraGeneration || opController.signal.aborted)
          throw new Error('Configuration context changed before dispatch')
        moonrakerApiKey.value = ''
        login.clear?.()
        persistPendingOperation(candidate, 'awaiting-reconcile')
        opContext = candidate
        kobraOperation.value = candidate
      },
    })
    await applySessionOutcome(outcome, candidate, token, opController.signal)
  } catch (cause) {
    await handleKobraException(cause, opContext, token, opContext !== null)
  } finally {
    if (token === kobraGeneration) kobraBusy.value = false
  }
}

async function prepareBambuPrinter() {
  if (kobraBusy.value || kobraBootstrap.value.kind !== 'ready') return
  kobraError.value = ''
  kobraStatus.value = ''
  const validated = validateBambuTargetInput({
    ipv4: bambuIp.value.trim(),
    serial: bambuSerial.value.trim(),
    accessCode: bambuAccessCode.value,
    control: bambuControl.value,
    displayLabel: kobraLabel.value,
  })
  const expectedRevision = kobraBootstrap.value.data.bootstrap.revision
  if (!validated.ok || expectedRevision === null) {
    kobraError.value = validated.ok
      ? 'Configuração não disponível neste Connector.'
      : validated.error
    await nextTick()
    kobraErrorSummary.value?.focus()
    return
  }
  const token = kobraGeneration
  const opController = (kobraController = new AbortController())
  kobraBusy.value = true
  kobraStage.value = 'preparing'
  kobraStatus.value =
    'Conectando via WebRTC config-v1 e verificando a Bambu Lab na LAN do Connector…'
  let opContext: KobraOperationContext | null = null
  try {
    const targetSha256 = await configurationTargetHash(validated.target)
    if (kobraKeyState.value.kind !== 'available')
      throw new Error('Approved browser key required')
    if (token !== kobraGeneration || opController.signal.aborted) return
    const candidate: KobraOperationContext = {
      accountId: kobraKeyState.value.accountId,
      operationId: crypto.randomUUID(),
      farmId: farmId.value,
      agentId: kobraAgentId.value,
      keyId: kobraKeyId.value,
      target: withoutBambuAccessCode(validated.target),
      targetSha256,
      expectedRevision,
      displayLabel: validated.displayLabel,
      preparedReceipt: null,
      preparedReceiptSha256: null,
    }
    const session = await ensureKobraSession(opController.signal)
    if (token !== kobraGeneration) return
    const outcome = await session.prepare({
      operationId: candidate.operationId,
      target: validated.target,
      expectedRevision: candidate.expectedRevision,
      signal: opController.signal,
      beforeDispatch: () => {
        if (token !== kobraGeneration || opController.signal.aborted)
          throw new Error('Configuration context changed before dispatch')
        bambuAccessCode.value = ''
        persistPendingOperation(candidate, 'awaiting-reconcile')
        opContext = candidate
        kobraOperation.value = candidate
      },
    })
    await applySessionOutcome(outcome, candidate, token, opController.signal)
  } catch (cause) {
    await handleKobraException(cause, opContext, token, opContext !== null)
  } finally {
    if (token === kobraGeneration) kobraBusy.value = false
  }
}

async function prepareAnycubicPrinter() {
  if (kobraBusy.value || kobraBootstrap.value.kind !== 'ready') return
  kobraError.value = ''
  kobraStatus.value = ''
  const validated = validateAnycubicTargetInput({
    host: anycubicHost.value.trim(),
    port: Number(anycubicPort.value),
    modelId: anycubicModelId.value.trim(),
    deviceId: anycubicDeviceId.value.trim(),
    username: anycubicUsername.value,
    password: anycubicPassword.value,
    ...(typeof anycubicCaFile !== 'undefined' && anycubicCaFile.value
      ? { caFile: anycubicCaFile.value }
      : {}),
    ...(typeof anycubicPin !== 'undefined' && anycubicPin.value
      ? { pinSha256: anycubicPin.value }
      : {}),
    displayLabel: kobraLabel.value,
  })
  const expectedRevision = kobraBootstrap.value.data.bootstrap.revision
  if (!validated.ok || expectedRevision === null) {
    kobraError.value = validated.ok
      ? 'Configuração não disponível neste Connector.'
      : validated.error
    await nextTick()
    kobraErrorSummary.value?.focus()
    return
  }
  const token = kobraGeneration
  const opController = (kobraController = new AbortController())
  kobraBusy.value = true
  kobraStage.value = 'preparing'
  kobraStatus.value =
    'Conectando via WebRTC config-v1 e verificando a Anycubic Lab na LAN do Connector…'
  let opContext: KobraOperationContext | null = null
  try {
    const targetSha256 = await configurationTargetHash(validated.target)
    if (kobraKeyState.value.kind !== 'available')
      throw new Error('Approved browser key required')
    if (token !== kobraGeneration || opController.signal.aborted) return
    const candidate: KobraOperationContext = {
      accountId: kobraKeyState.value.accountId,
      operationId: crypto.randomUUID(),
      farmId: farmId.value,
      agentId: kobraAgentId.value,
      keyId: kobraKeyId.value,
      target: withoutAnycubicCredentials(validated.target),
      targetSha256,
      expectedRevision,
      displayLabel: validated.displayLabel,
      preparedReceipt: null,
      preparedReceiptSha256: null,
    }
    const session = await ensureKobraSession(opController.signal)
    if (token !== kobraGeneration) return
    const outcome = await session.prepare({
      operationId: candidate.operationId,
      target: validated.target,
      expectedRevision: candidate.expectedRevision,
      signal: opController.signal,
      beforeDispatch: () => {
        if (token !== kobraGeneration || opController.signal.aborted)
          throw new Error('Configuration context changed before dispatch')
        anycubicPassword.value = ''
        anycubicUsername.value = ''
        persistPendingOperation(candidate, 'awaiting-reconcile')
        opContext = candidate
        kobraOperation.value = candidate
      },
    })
    await applySessionOutcome(outcome, candidate, token, opController.signal)
  } catch (cause) {
    await handleKobraException(cause, opContext, token, opContext !== null)
  } finally {
    if (token === kobraGeneration) kobraBusy.value = false
  }
}

async function prepareCrealityPrinter() {
  if (kobraBusy.value || kobraBootstrap.value.kind !== 'ready') return
  kobraError.value = ''
  kobraStatus.value = ''
  const validated = validateCrealityTargetInput({
    host: crealityHost.value.trim(),
    displayLabel: kobraLabel.value,
  })
  const expectedRevision = kobraBootstrap.value.data.bootstrap.revision
  if (!validated.ok || expectedRevision === null) {
    kobraError.value = validated.ok
      ? 'Configuração não disponível neste Connector.'
      : validated.error
    await nextTick()
    kobraErrorSummary.value?.focus()
    return
  }
  const token = kobraGeneration
  const opController = (kobraController = new AbortController())
  kobraBusy.value = true
  kobraStage.value = 'preparing'
  kobraStatus.value =
    'Conectando via WebRTC config-v1 e verificando a Creality na LAN do Connector…'
  let opContext: KobraOperationContext | null = null
  try {
    const targetSha256 = await configurationTargetHash(validated.target)
    if (kobraKeyState.value.kind !== 'available')
      throw new Error('Approved browser key required')
    if (token !== kobraGeneration || opController.signal.aborted) return
    const candidate: KobraOperationContext = {
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
    const session = await ensureKobraSession(opController.signal)
    if (token !== kobraGeneration) return
    const outcome = await session.prepare({
      operationId: candidate.operationId,
      target: validated.target,
      expectedRevision: candidate.expectedRevision,
      signal: opController.signal,
      beforeDispatch: () => {
        if (token !== kobraGeneration || opController.signal.aborted)
          throw new Error('Configuration context changed before dispatch')
        persistPendingOperation(candidate, 'awaiting-reconcile')
        opContext = candidate
        kobraOperation.value = candidate
      },
    })
    await applySessionOutcome(outcome, candidate, token, opController.signal)
  } catch (cause) {
    await handleKobraException(cause, opContext, token, opContext !== null)
  } finally {
    if (token === kobraGeneration) kobraBusy.value = false
  }
}

let stopWatching: (() => void) | undefined
onMounted(() => {
  heading.value?.focus()
  void setup.loadFarms()
  stopWatching = setup.watchSession()
})

onBeforeUnmount(() => {
  stopWatching?.()
  setup.clear()
})
onBeforeRouteLeave(setup.clear)
</script>
<template>
  <main id="conteudo">
    <h1 ref="heading" tabindex="-1">Impressoras da farm</h1>
    <PrintersNavIntro />
    <p v-if="error" ref="errorSummary" role="alert" tabindex="-1">
      {{ error }} <NuxtLink to="/entrar">Entrar novamente</NuxtLink>
    </p>
    <p role="status" aria-live="polite">{{ pending ? 'Aguarde.' : message }}</p>
    <PrintersFarmSelector />
    <AssignmentList />
    <section
      v-if="farmId && canManage"
      aria-labelledby="kobra-x-heading"
      :aria-busy="kobraBusy"
    >
      <h2 id="kobra-x-heading">Adicionar impressora</h2>
      <p id="kobra-x-intro">
        Adicione uma impressora Klipper / Moonraker ou Anycubic Kobra X pelo
        Connector. Para Kobra X, ative o
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
      <ConnectorContext />
      <div v-if="kobraStage === 'idle'" class="setup-columns">
        <div class="kobra-card">
          <h3>Descobrir impressoras</h3>
          <DiscoveryPanel />
        </div>
        <SetupForm />
      </div>
      <div v-if="kobraBusy" class="kobra-actions">
        <button type="button" @click="setup.abortLocalKobraWait">
          Interromper espera local
        </button>
      </div>
      <PreparedReview />
      <OperationStatus />
    </section>
    <RegisterAssignment />
    <RevokeConfirmation />
  </main>
</template>
<style scoped src="../components/printer-setup/printer-setup.css"></style>
