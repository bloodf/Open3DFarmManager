<script setup lang="ts">
import type { DiscoveryResult } from '../../../../../packages/farm-protocol/src/configuration-discovery.ts'
type Printer = Extract<DiscoveryResult, { ok: true }>['printers'][number]
defineProps<{ printers: Printer[] }>()
defineEmits<{ select: [printer: Printer] }>()
</script>

<template>
  <ul v-if="printers.length">
    <li v-for="(printer, index) in printers" :key="index">
      {{
        printer.name ||
        printer.model ||
        (printer.vendor === 'bambu' ? 'Bambu Lab' : 'Moonraker')
      }}
      · {{ printer.host }}
      <button type="button" @click="$emit('select', printer)">
        Selecionar {{ printer.name || printer.host }}
      </button>
    </li>
  </ul>
</template>
