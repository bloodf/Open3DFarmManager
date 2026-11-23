<script setup lang="ts">
import { computed } from 'vue'
import { adoptionPrinter } from '../../utils/network-adoption.ts'
import {
  connectorName,
  type NetworkDiscovered,
} from '../../utils/network-map.ts'
import { discoveryLabel } from '../../utils/printer-discovery-view.ts'
import type { DiscoveredPrinter } from '../../utils/printer-setup-state.ts'

const props = defineProps<{ found: NetworkDiscovered }>()
const emit = defineEmits<{ adopt: [printer: DiscoveredPrinter] }>()
const printer = computed(() => adoptionPrinter(props.found))
</script>

<template>
  <button
    v-if="printer"
    type="button"
    :aria-label="`Adicionar à farm: ${discoveryLabel(printer)} · ${connectorName(found.agentId)}`"
    @click="emit('adopt', printer)"
  >
    Adicionar à farm
  </button>
</template>
