<script setup lang="ts">
import { computed } from 'vue'
import { printerIdentityView } from '../../utils/printer-identity-view'
import type { ObservedPrinterIdentity } from '../../utils/compatibility/match'

const props = defineProps<{ identity?: ObservedPrinterIdentity | null }>()
const view = computed(() => printerIdentityView(props.identity))
</script>

<template>
  <div>
    <p>Modelo: {{ view.model }}</p>
    <p>Firmware: {{ view.firmware }}</p>
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
