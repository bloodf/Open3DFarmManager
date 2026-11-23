<script setup lang="ts">
import ConnectorContext from './ConnectorContext.vue'
import DiscoveryPanel from './DiscoveryPanel.vue'
import OperationStatus from './OperationStatus.vue'
import PreparedReview from './PreparedReview.vue'
import SetupForm from './SetupForm.vue'
import { usePrinterSetup } from '../../utils/printer-setup-state.ts'
import { usePrinterSetupActions } from '../../utils/printer-setup-actions.ts'

const { kobraBusy, kobraError, kobraStatus, kobraStage, kobraErrorSummary } =
  usePrinterSetup()
const { abortLocalKobraWait } = usePrinterSetupActions()
</script>

<template>
  <section
    class="panel"
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
    <p role="status" aria-live="polite" class="live">
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
      <button type="button" @click="abortLocalKobraWait">
        Interromper espera local
      </button>
    </div>
    <PreparedReview />
    <OperationStatus />
  </section>
</template>

<style scoped>
.kobra-alert {
  margin: 0 0 var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--state-error-color);
  border-radius: var(--radius-sm);
  color: var(--state-error-color);
  font-weight: var(--font-weight-semibold);
}

.setup-columns {
  display: grid;
  gap: var(--space-5);
  min-width: 0;
}

.setup-columns > * {
  min-width: 0;
}

.kobra-card {
  min-width: 0;
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}

.kobra-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
  align-items: center;
}

@media (min-width: 48rem) {
  .setup-columns {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    align-items: start;
  }
}
.live {
  margin: 0;
}
.live:empty {
  display: none;
}
</style>
