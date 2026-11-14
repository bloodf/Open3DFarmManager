<script setup lang="ts">
import { computed } from 'vue'
import type { PrinterState } from '../../../../packages/farm-protocol/src/state.ts'
import { farmMaterialsView } from '../utils/farm-materials-view.ts'

const props = defineProps<{ materials: PrinterState['materials'] }>()
const trays = computed(() => farmMaterialsView(props.materials))
</script>

<template>
  <section v-if="trays !== undefined" aria-label="Materiais">
    <h4>Materiais</h4>
    <p v-if="!trays.length">Nenhuma bandeja informada.</p>
    <ul v-else>
      <li v-for="(tray, index) in trays" :key="index">
        {{ tray.slot }} — {{ tray.material }}
        <span
          v-if="tray.color"
          class="swatch"
          :style="{ backgroundColor: tray.color }"
          aria-hidden="true"
        />
        <span>{{ tray.colorLabel }}</span> — Restante: {{ tray.remaining }}
        <strong v-if="tray.active"> — Bandeja ativa</strong>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.swatch {
  display: inline-block;
  width: 1em;
  height: 1em;
  border: 1px solid currentColor;
  vertical-align: middle;
}
</style>
