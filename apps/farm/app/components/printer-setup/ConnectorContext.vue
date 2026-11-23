<script setup lang="ts">
import { usePrinterSetup } from '../../utils/printer-setup-state.ts'
import { usePrinterSetupActions } from '../../utils/printer-setup-actions.ts'

const {
  connectors,
  kobraAgentId,
  kobraKeyId,
  kobraKeyState,
  kobraBootstrap,
  kobraBusy,
  kobraKeyMessage,
} = usePrinterSetup()
const { onKobraContextChange, refreshKobraContext } = usePrinterSetupActions()
</script>

<template>
  <fieldset :disabled="kobraBusy">
    <legend>1. Connector e dispositivo do navegador</legend>
    <label for="kobra-connector">Connector aprovado para a impressora</label>
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
      <label for="kobra-device-key">Dispositivo aprovado deste navegador</label>
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
</template>

<style scoped src="./printer-setup.css"></style>
