<script setup lang="ts">
import { computed } from 'vue'
import { printerIdentityView } from '../../utils/printer-identity-view'
import {
  firmwareView,
  type FirmwareStatus,
} from '../../utils/farm-firmware-view'
import type { ObservedPrinterIdentity } from '../../utils/compatibility/match'

const props = defineProps<{
  identity?: ObservedPrinterIdentity | null
  firmware?: FirmwareStatus
}>()
const view = computed(() => printerIdentityView(props.identity))
const firmware = computed(() =>
  firmwareView(props.firmware, props.identity?.firmware),
)
</script>

<template>
  <div>
    <p>Modelo: {{ view.model }}</p>
    <p>Firmware: {{ firmware.current }}</p>
    <p v-if="firmware.updateAvailable">
      Atualização disponível<span v-if="firmware.latest"
        >: {{ firmware.latest }}</span
      >
    </p>
    <ul v-if="firmware.components.length">
      <li v-for="component in firmware.components" :key="component.name">
        {{ component.name }}: {{ component.current
        }}<span v-if="component.latest">
          (mais recente: {{ component.latest }})</span
        >
      </li>
    </ul>
    <p>Atualizações são feitas na impressora, não pelo OpenFarm.</p>
    <template v-if="view.compatibility">
      <NuxtLink :to="view.compatibility.href"
        >Compatibilidade: {{ view.compatibility.label }}</NuxtLink
      >
      <ul>
        <li v-for="status in view.compatibility.statuses" :key="status.label">
          {{ status.label }}: {{ status.value }}
        </li>
      </ul>
    </template>
    <p v-else>Compatibilidade: não identificado</p>
  </div>
</template>
