<script setup lang="ts">
import { computed, reactive } from 'vue'
import type { FarmKeyState, FarmRow } from '../utils/farm-view.ts'
import { controlActionAvailability, type Clock } from '../utils/farm-control.ts'
import {
  advertisedExtended,
  buildExtendedArgs,
  extendedLabel,
  type FarmExtendedAction,
} from '../utils/farm-control-extended.ts'
const props = defineProps<{
  row: FarmRow
  keys: FarmKeyState
  controlEnabled: boolean
  commandInFlight: boolean
  now: Clock
  lastResult?: string | null
}>()
const emit = defineEmits<{
  (
    e: 'action',
    action: FarmExtendedAction,
    args: Record<string, unknown>,
    event: Event,
  ): void
}>()
const actions = computed(() =>
  advertisedExtended(props.row.observation?.state.controls),
)
const choices = reactive<Record<string, string>>({
  set_temperature: 'extruder',
  set_fan: 'part',
  set_light: 'on',
  set_speed: 'standard',
})
// A number input's v-model yields a number, so readers convert it to text.
const values = reactive<Record<string, string | number>>({
  set_temperature: '',
  set_fan: '',
})
function available(action: FarmExtendedAction) {
  return controlActionAvailability(
    action,
    props.row,
    props.keys,
    props.controlEnabled,
    // The tick keeps this reactive; a fresh sample keeps a frame received
    // after the last tick from having a negative age.
    (void props.now, { wall: Date.now(), mono: performance.now() }),
  ).available
}
function submit(action: FarmExtendedAction, event: Event) {
  const args = buildExtendedArgs(
    action,
    choices[action] ?? '',
    String(values[action] ?? ''),
  )
  if (args && available(action) && !props.commandInFlight)
    emit('action', action, args, event)
}
</script>
<template>
  <section
    v-if="actions.length"
    :aria-label="'Controles adicionais de ' + row.assignment.printerKey"
  >
    <h4>Controles adicionais</h4>
    <p v-if="lastResult" role="status" aria-live="polite">{{ lastResult }}</p>
    <div v-for="action in actions" :key="action" class="control">
      <label v-if="action === 'set_temperature'"
        >Aquecedor
        <select
          v-model="choices[action]"
          :disabled="!available(action) || commandInFlight"
        >
          <option value="extruder">Bico</option>
          <option value="bed">Mesa</option>
          <option value="chamber">Câmara</option>
        </select></label
      >
      <label v-if="action === 'set_fan'"
        >Ventilador
        <select
          v-model="choices[action]"
          :disabled="!available(action) || commandInFlight"
        >
          <option value="part">Peça</option>
          <option value="aux">Auxiliar</option>
          <option value="chamber">Câmara</option>
        </select></label
      >
      <label v-if="action === 'set_temperature' || action === 'set_fan'"
        >{{
          action === 'set_temperature' ? 'Temperatura em °C' : 'Velocidade em %'
        }}
        <input
          v-model="values[action]"
          type="number"
          min="0"
          :max="
            action === 'set_fan'
              ? 100
              : choices[action] === 'bed'
                ? 120
                : choices[action] === 'chamber'
                  ? 65
                  : 300
          "
          step="1"
          :disabled="!available(action) || commandInFlight"
      /></label>
      <label v-if="action === 'set_light'"
        >Luz
        <select
          v-model="choices[action]"
          :disabled="!available(action) || commandInFlight"
        >
          <option value="on">Ligar</option>
          <option value="off">Desligar</option>
        </select></label
      >
      <label v-if="action === 'set_speed'"
        >Velocidade
        <select
          v-model="choices[action]"
          :disabled="!available(action) || commandInFlight"
        >
          <option value="silent">Silenciosa</option>
          <option value="standard">Padrão</option>
          <option value="sport">Esportiva</option>
          <option value="ludicrous">Máxima</option>
        </select></label
      >
      <button
        type="button"
        :class="{ emergency: action === 'emergency_stop' }"
        :disabled="
          !available(action) ||
          commandInFlight ||
          !buildExtendedArgs(
            action,
            choices[action] ?? '',
            String(values[action] ?? ''),
          )
        "
        @click="submit(action, $event)"
      >
        {{ extendedLabel(action) }}
      </button>
      <p v-if="!available(action)">
        Controle indisponível; é necessária uma conexão direta atual e
        autorizada.
      </p>
    </div>
  </section>
</template>
<style scoped>
.control {
  margin-block: 1rem;
}
label {
  display: block;
}
button,
input,
select {
  font: inherit;
  min-height: 2.75rem;
}
.emergency {
  font-weight: bold;
  border: 3px solid #a00;
  color: #900;
}
:focus-visible {
  outline: 3px solid currentColor;
  outline-offset: 3px;
}
</style>
