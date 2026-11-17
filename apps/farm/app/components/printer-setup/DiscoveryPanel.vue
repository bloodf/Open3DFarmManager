<script setup lang="ts">
import DiscoveryResults from '../printer-discovery/Results.vue'
import { usePrinterSetup } from '../../utils/printer-setup-state.ts'
import { usePrinterSetupActions } from '../../utils/printer-setup-actions.ts'

const {
  discoveryPrinters,
  discoveryMessage,
  discoveryBusy,
  probeHost,
  kobraBootstrap,
  kobraBusy,
} = usePrinterSetup()
const { searchPrinters, selectDiscovery } = usePrinterSetupActions()
</script>

<template>
  <button
    type="button"
    :disabled="discoveryBusy || kobraBusy || kobraBootstrap.kind !== 'ready'"
    @click="searchPrinters()"
  >
    Procurar impressoras
  </button>
  <label for="probe-host">Endereço IPv4 da impressora</label>
  <input
    id="probe-host"
    v-model="probeHost"
    placeholder="192.168.1.50"
    :disabled="discoveryBusy"
  />
  <button
    type="button"
    :disabled="
      discoveryBusy ||
      kobraBusy ||
      kobraBootstrap.kind !== 'ready' ||
      !probeHost.trim()
    "
    @click="searchPrinters(probeHost.trim())"
  >
    Identificar
  </button>
  <p role="status" aria-live="polite">{{ discoveryMessage }}</p>
  <DiscoveryResults :printers="discoveryPrinters" @select="selectDiscovery" />
</template>

<style scoped src="./printer-setup.css"></style>
