<script setup lang="ts">
import type { DiscoveryResult } from '../../../../../packages/farm-protocol/src/configuration-discovery.ts'
import { discoveryLabel } from '../../utils/printer-discovery-view.ts'
type Printer = Extract<DiscoveryResult, { ok: true }>['printers'][number]
defineProps<{ printers: Printer[] }>()
defineEmits<{ select: [printer: Printer] }>()
</script>

<template>
  <ul v-if="printers.length">
    <li v-for="(printer, index) in printers" :key="index">
      {{ discoveryLabel(printer) }}
      · {{ printer.host }}
      <button type="button" @click="$emit('select', printer)">
        Selecionar {{ printer.name || printer.host }}
      </button>
    </li>
  </ul>
</template>
