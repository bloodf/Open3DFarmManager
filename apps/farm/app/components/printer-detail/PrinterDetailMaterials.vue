<script setup lang="ts">
import type { ActiveSpool } from '../../../../../packages/farm-protocol/src/status.ts'
import type { PrinterState } from '../../../../../packages/farm-protocol/src/state.ts'
import type { SlotBinding } from '../../utils/slot-spools.ts'
import FarmMaterials from '../FarmMaterials.vue'

withDefaults(
  defineProps<{
    materials: PrinterState['materials']
    activeSpools?: readonly ActiveSpool[]
    historical?: boolean
    bindings?: Readonly<Record<string, SlotBinding | undefined>>
    heading?: string
  }>(),
  { heading: 'Bandejas de filamento' },
)
</script>

<template>
  <div v-if="materials?.length">
    <template v-if="historical">
      <h2>{{ heading }}</h2>
      <p>Materiais indisponíveis: os dados estão desatualizados.</p>
    </template>
    <FarmMaterials
      v-else
      :materials="materials"
      :bindings="bindings"
      :active-spools="activeSpools"
      :heading="heading"
      :heading-level="2"
    />
  </div>
</template>
