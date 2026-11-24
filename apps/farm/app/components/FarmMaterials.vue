<script setup lang="ts">
import { computed } from 'vue'
import type { PrinterState } from '../../../../packages/farm-protocol/src/state.ts'
import type { ActiveSpool } from '../../../../packages/farm-protocol/src/status.ts'
import { farmMaterialsView } from '../utils/farm-materials-view.ts'
import SpoolIllustration from './spool-library/SpoolIllustration.vue'

const props = withDefaults(
  defineProps<{
    materials: PrinterState['materials']
    activeSpools?: readonly ActiveSpool[]
    title?: string
    headingLevel?: 2 | 4
  }>(),
  { title: 'Materiais', headingLevel: 4 },
)
const trays = computed(() => {
  const spools = new Map(
    props.activeSpools?.map((spool) => [spool.slot, spool]),
  )
  return farmMaterialsView(
    props.materials?.map((material) => {
      const spool = spools.get(material.slot)
      return {
        ...material,
        remainingPercent: spool?.remainingPercent ?? material.remainingPercent,
        colorHex: spool?.colorHex
          ? `${spool.colorHex.toUpperCase()}FF`
          : material.colorHex,
      }
    }),
  )
})
</script>

<template>
  <section v-if="trays !== undefined" :aria-label="title">
    <component :is="`h${headingLevel}`">{{ title }}</component>
    <p v-if="!trays.length">Nenhuma bandeja informada.</p>
    <ul v-else>
      <li v-for="(tray, index) in trays" :key="index">
        <SpoolIllustration
          :filament="{ color_hex: tray.color?.slice(0, 7) }"
          :printer-percent="tray.remainingPercent"
          compact
        />
        <span>
          {{ tray.slot }} — {{ tray.material }} · {{ tray.colorLabel }} —
          Restante: {{ tray.remaining }}
          <strong v-if="tray.active"> — Bandeja ativa</strong>
        </span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
ul {
  padding: 0;
  list-style: none;
}
li {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  overflow-wrap: anywhere;
}
</style>
