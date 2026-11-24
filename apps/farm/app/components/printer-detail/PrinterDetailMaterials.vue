<script setup lang="ts">
import type { PrinterState } from '../../../../../packages/farm-protocol/src/state.ts'
import FarmMaterials from '../FarmMaterials.vue'

withDefaults(
  defineProps<{
    materials: PrinterState['materials']
    historical?: boolean
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
      :heading="heading"
      :heading-level="2"
    />
  </div>
</template>
