<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import {
  observationAge,
  type FarmKeyState,
  type FarmRow,
} from '../utils/farm-view.ts'
import { controlActionAvailability, type Clock } from '../utils/farm-control.ts'
import { filamentTrays, macroActions, macroArgs } from '../utils/farm-macros.ts'
import FarmSpool from './spool-art/FarmSpool.vue'
import { farmSlotViews, type SlotBinding } from '../utils/slot-spools.ts'
import type { ExtendedControlAction } from '../../../../packages/farm-protocol/src/control-actions.ts'
import type { ActiveSpool } from '../../../../packages/farm-protocol/src/status.ts'
const props = defineProps<{
  row: FarmRow
  keys: FarmKeyState
  controlEnabled: boolean
  commandInFlight: boolean
  now: Clock
  bindings?: Readonly<Record<string, SlotBinding | undefined>>
  activeSpools?: readonly ActiveSpool[]
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
const trays = computed(() => {
  const observation = props.row.observation
  return filamentTrays(
    observation && !observationAge(observation, props.now).stale
      ? observation.state
      : undefined,
  )
})
const tray = ref('')
const selected = computed(() =>
  trays.value.find((item) => String(item.id) === tray.value),
)
/** A chosen tray that left the live observation. Never replaced by automatic. */
const trayMissing = computed(() => tray.value !== '' && !selected.value)
const trayMissingId = useId()
const selectedSpool = computed(() => {
  const material = selected.value?.material
  if (!material) return undefined
  return farmSlotViews([material], props.bindings, props.activeSpools)?.[0]
})
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
  if (!available('load_filament') || trayMissing.value) return
  emit(
    'action',
    'load_filament',
    selected.value ? { tray: selected.value.id } : {},
    event,
  )
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
      <label v-if="trays.length || trayMissing"
        >Bandeja AMS
        <select
          v-model="tray"
          :disabled="!available('load_filament')"
          :aria-invalid="trayMissing ? 'true' : undefined"
          :aria-describedby="trayMissing ? trayMissingId : undefined"
        >
          <option value="">Seleção automática</option>
          <option v-if="trayMissing" :value="tray" disabled>
            Bandeja indisponível
          </option>
          <option v-for="item in trays" :key="item.id" :value="String(item.id)">
            {{ item.label }}
          </option>
        </select>
      </label>
      <FarmSpool
        announce-level
        v-if="selectedSpool"
        :color="selectedSpool.color"
        :fraction="
          selectedSpool.level.kind === 'known'
            ? selectedSpool.level.fraction
            : null
        "
        :size="32"
      />
      <p v-if="trayMissing" :id="trayMissingId" role="alert">
        A bandeja selecionada não está mais disponível. Escolha outra bandeja ou
        a seleção automática para carregar.
      </p>
      <button
        type="button"
        :disabled="!available('load_filament') || trayMissing"
        :aria-describedby="trayMissing ? trayMissingId : undefined"
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
