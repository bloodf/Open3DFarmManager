<script setup lang="ts">
import { computed, ref } from 'vue'
import type { FarmKeyState, FarmRow } from '../utils/farm-view.ts'
import { controlActionAvailability, type Clock } from '../utils/farm-control.ts'
import { filamentTrays, macroActions, macroArgs } from '../utils/farm-macros.ts'
import type { ExtendedControlAction } from '../../../../packages/farm-protocol/src/control-actions.ts'
const props = defineProps<{
  row: FarmRow
  keys: FarmKeyState
  controlEnabled: boolean
  commandInFlight: boolean
  now: Clock
}>()
const emit = defineEmits<{
  (
    e: 'action',
    action: ExtendedControlAction,
    args: Record<string, unknown>,
    event: Event,
  ): void
}>()
const actions = computed(() => macroActions(props.row.observation?.state))
const trays = computed(() => filamentTrays(props.row.observation?.state))
const tray = ref('')
function available(action: ExtendedControlAction) {
  return (
    !props.commandInFlight &&
    controlActionAvailability(
      action,
      props.row,
      props.keys,
      props.controlEnabled,
      props.now,
    ).available
  )
}
function run(name: string, event: Event) {
  const args = macroArgs(props.row.observation?.state, name)
  if (args && available('run_macro')) emit('action', 'run_macro', args, event)
}
function load(event: Event) {
  if (!available('load_filament')) return
  const selected = trays.value.find((item) => String(item.id) === tray.value)
  if (tray.value && !selected) return
  emit('action', 'load_filament', selected ? { tray: selected.id } : {}, event)
}
</script>
<template>
  <section
    v-if="actions.macros.length || actions.load || actions.unload"
    :aria-label="`Macros e filamento de ${row.assignment.printerKey}`"
  >
    <h4>Macros e filamento</h4>
    <button
      v-for="name in actions.macros"
      :key="name"
      type="button"
      :disabled="!available('run_macro')"
      @click="run(name, $event)"
    >
      Executar {{ name }}
    </button>
    <template v-if="actions.load">
      <label v-if="trays.length"
        >Bandeja AMS
        <select v-model="tray" :disabled="!available('load_filament')">
          <option value="">Seleção automática</option>
          <option v-for="item in trays" :key="item.id" :value="String(item.id)">
            {{ item.label }}
          </option>
        </select>
      </label>
      <button
        type="button"
        :disabled="!available('load_filament')"
        @click="load"
      >
        Carregar filamento
      </button>
    </template>
    <button
      v-if="actions.unload"
      type="button"
      :disabled="!available('unload_filament')"
      @click="emit('action', 'unload_filament', {}, $event)"
    >
      Descarregar filamento
    </button>
  </section>
</template>
<style scoped>
button,
select {
  font: inherit;
  min-height: 2.75rem;
}
label {
  display: block;
}
:focus-visible {
  outline: 3px solid currentColor;
  outline-offset: 3px;
}
</style>
