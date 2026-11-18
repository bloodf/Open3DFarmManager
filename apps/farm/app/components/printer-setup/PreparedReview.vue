<script setup lang="ts">
import { KOBRA_X_DEVICE_CAPABILITIES } from '../../utils/kobralink-onboarding.ts'
import { BAMBU_LAN_COMMAND_NOTE } from '../../utils/bambu-onboarding.ts'
import { usePrinterSetup } from '../../utils/printer-setup-state.ts'
import { usePrinterSetupActions } from '../../utils/printer-setup-actions.ts'

const {
  kobraBusy,
  kobraStage,
  kobraCommitConfirmed,
  kobraOperation,
  kobraPrepared,
  anycubicTargetView,
  isAnycubicOnboarding,
  isCrealityOnboarding,
  isBambuOnboarding,
  isMoonrakerOnboarding,
  onboardingFamilyLabel,
} = usePrinterSetup()
const { commitKobraX, cancelKobraX } = usePrinterSetupActions()
</script>

<template>
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
    <dl v-if="anycubicTargetView">
      <dt>Endereço LAN</dt>
      <dd>{{ anycubicTargetView.host }}:{{ anycubicTargetView.port }}</dd>
      <dt>Modelo configurado</dt>
      <dd>{{ anycubicTargetView.modelId }}</dd>
      <dt>Dispositivo configurado</dt>
      <dd>{{ anycubicTargetView.deviceId }}</dd>
      <dt>Credenciais LAN</dt>
      <dd>{{ anycubicTargetView.credentials }}</dd>
    </dl>
    <dl>
      <dt>Operação</dt>
      <dd class="exact-key">{{ kobraPrepared.operationId }}</dd>
      <dt>Identidade estável observada (device_id)</dt>
      <dd class="exact-key">
        {{ kobraPrepared.receipt.observed.device_id }}
      </dd>
      <dt>
        {{
          isMoonrakerOnboarding
            ? 'Identidade da origem no Connector'
            : isBambuOnboarding || isAnycubicOnboarding
              ? 'Identidade da impressora no Connector'
              : 'Instância da ponte no Connector'
        }}
      </dt>
      <dd class="exact-key">
        {{ kobraPrepared.receipt.target.bridge_instance_id }}
      </dd>
      <dt>Modelo observado</dt>
      <dd>
        {{
          kobraPrepared.receipt.observed.model ??
          'Modelo não informado pela impressora'
        }}
        — Suporte não qualificado ({{ onboardingFamilyLabel }})
      </dd>
      <dt>Firmware observado</dt>
      <dd>
        <template
          v-if="kobraPrepared.receipt.observed.firmware.status === 'observed'"
        >
          Versão observada:
          {{ kobraPrepared.receipt.observed.firmware.version }} — suporte não
          qualificado (unqualified; somente leitura)
        </template>
        <template v-else>
          Firmware desconhecido (unknown) — suporte não qualificado
          (unqualified; somente leitura)
        </template>
      </dd>
      <dt>Revisão esperada no Connector</dt>
      <dd>{{ kobraPrepared.expectedRevision }}</dd>
    </dl>
    <h4>Capacidades admitidas para esta impressora</h4>
    <p v-if="isAnycubicOnboarding">
      Credenciais LAN: configurado (guardadas somente no Connector). Suporte não
      qualificado. Controles dependem do driver registrado no Connector.
    </p>
    <p v-else-if="isMoonrakerOnboarding || isCrealityOnboarding">
      Telemetria somente leitura. Comandos e câmera não qualificados.
    </p>
    <template
      v-else-if="
        isBambuOnboarding && kobraOperation?.target.backend === 'bambu'
      "
    >
      <p>
        Telemetria pela LAN. Código de acesso: configurado (guardado somente no
        Connector).

        {{
          kobraOperation.target.control
            ? 'Comandos habilitados por opção explícita.'
            : 'Comandos desabilitados: somente telemetria.'
        }}
      </p>
      <p>{{ BAMBU_LAN_COMMAND_NOTE }}</p>
    </template>
    <dl>
      <div
        v-for="cap in isAnycubicOnboarding ||
        isMoonrakerOnboarding ||
        isBambuOnboarding ||
        isCrealityOnboarding
          ? []
          : KOBRA_X_DEVICE_CAPABILITIES"
        :key="cap.id"
      >
        <dt>{{ cap.label }}</dt>
        <dd>{{ cap.statusText }} — {{ cap.reason }}</dd>
      </div>
    </dl>
    <p
      v-if="
        !isAnycubicOnboarding &&
        !isMoonrakerOnboarding &&
        !isBambuOnboarding &&
        !isCrealityOnboarding
      "
    >
      Certificado de cliente MQTT: validado e retido somente no armazenamento
      privado do Connector (0600); a chave privada nunca é salva no servidor nem
      exibida novamente.
    </p>
    <label class="confirmation">
      <input
        id="kobra-confirm-checkbox"
        v-model="kobraCommitConfirmed"
        type="checkbox"
        :disabled="kobraBusy"
      />
      Conferi a identidade observada ({{
        kobraPrepared.receipt.observed.device_id
      }}), a qualificação provisória de modelo/firmware e que esta
      {{
        isAnycubicOnboarding
          ? 'os controles dependem do driver registrado no Connector.'
          : 'esta impressora operará somente em leitura.'
      }}
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
            : 'Confirmar e ativar impressora'
        }}
      </button>
      <button type="button" :disabled="kobraBusy" @click="cancelKobraX">
        Cancelar preparação
      </button>
    </div>
  </section>
</template>

<style scoped src="./printer-setup.css"></style>
