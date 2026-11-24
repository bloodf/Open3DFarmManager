<script setup lang="ts">
import { computed } from 'vue'
import type { PrinterState } from '../../../../packages/farm-protocol/src/state.ts'
import { farmSlotViews, type SlotBinding } from '../utils/farm-slot-view.ts'
import FarmSlot from './spool-art/FarmSlot.vue'

const props = withDefaults(
  defineProps<{
    materials: PrinterState['materials']
    /** Spoolman weights of the spool verified as bound to each slot. */
    bindings?: Readonly<Record<string, SlotBinding | undefined>>
    hideHeading?: boolean
    heading?: string
    headingLevel?: 2 | 3 | 4
  }>(),
  { bindings: undefined, heading: 'Materiais', headingLevel: 4 },
)
const trays = computed(() => farmSlotViews(props.materials, props.bindings))
</script>

<template>
  <section v-if="trays !== undefined" :aria-label="heading">
    <component v-if="!hideHeading" :is="`h${headingLevel}`">{{
      heading
    }}</component>
    <p v-if="!trays.length">Nenhuma bandeja informada.</p>
    <ul v-else class="farm-materials">
      <li v-for="tray in trays" :key="tray.key">
        <FarmSlot
          :label="tray.label"
          :material="tray.material"
          :color="tray.color"
          :color-name="tray.color && `Cor ${tray.color}`"
          :printer-percent="tray.printerPercent"
          :spoolman-remaining-weight="tray.spoolmanRemainingWeight"
          :spoolman-initial-weight="tray.spoolmanInitialWeight"
          :active="tray.active"
          :low="tray.low"
        >
          <template v-if="tray.active" #state>
            <strong>Bandeja ativa</strong>
          </template>
        </FarmSlot>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.farm-materials {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 13rem), 1fr));
  gap: var(--ops-space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}
</style>
