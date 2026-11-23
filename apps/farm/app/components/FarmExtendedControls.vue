<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import type { FarmKeyState, FarmRow } from '../utils/farm-view.ts'
import { controlActionAvailability, type Clock } from '../utils/farm-control.ts'
import {
  advertisedExtended,
  buildExtendedArgs,
  buildToolTemperatureArgs,
  extendedLabel,
  speedModeOptions,
  toolHeaterOptions,
  unsupportedExtended,
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
  advertisedExtended(props.row.observation?.state.controls).filter(
    (action) =>
      action !== 'set_tool_temperature' ||
      (props.row.observation?.state.toolHeaters?.length ?? 0) > 0,
  ),
)
const unsupported = computed(() =>
  unsupportedExtended(props.row.observation?.state.controls),
)
const choices = reactive<Record<string, string>>({
  set_temperature: 'extruder',
  set_fan: 'part',
  set_light: 'on',
  set_speed: 'standard',
})
const toolHeaters = computed(() =>
  toolHeaterOptions(props.row.observation?.state.toolHeaters),
)
const speedOptions = computed(() =>
  speedModeOptions(props.row.observation?.state.speedModes),
)
watch(
  speedOptions,
  (options) => {
    if (!options.some((option) => option.value === choices.set_speed))
      choices.set_speed = options[0]?.value ?? ''
  },
  { immediate: true },
)
// A number input's v-model yields a number, so readers convert it to text.
const values = reactive<Record<string, string | number>>({
  set_temperature: '',
  set_fan: '',
})
function toolArgs(heater: (typeof toolHeaters.value)[number]) {
  return buildToolTemperatureArgs(heater, values[`tool-${heater.tool}`] ?? '')
}
function submitTool(heater: (typeof toolHeaters.value)[number], event: Event) {
  const args = toolArgs(heater)
  const action = 'set_tool_temperature'
  if (args && available(action) && !props.commandInFlight)
    emit('action', action, args, event)
}
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
      <template v-if="action === 'set_tool_temperature'">
        <div v-for="heater in toolHeaters" :key="heater.tool">
          <label
            >{{ heater.label }} — Temperatura em °C
            <input
              v-model="values[`tool-${heater.tool}`]"
              type="number"
              min="0"
              step="1"
              :max="heater.maxC"
              :disabled="!available(action) || commandInFlight"
            />
          </label>
          <button
            type="button"
            :disabled="
              !available(action) || commandInFlight || !toolArgs(heater)
            "
            @click="submitTool(heater, $event)"
          >
            Definir temperatura
          </button>
        </div>
      </template>
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
          <option
            v-for="option in speedOptions"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </option>
        </select></label
      >
      <button
        v-if="action !== 'set_tool_temperature'"
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
    <template v-if="unsupported.length">
      <h5 :id="'unsupported-' + row.assignment.assignmentId">
        Comandos não suportados por esta impressora
      </h5>
      <dl :aria-labelledby="'unsupported-' + row.assignment.assignmentId">
        <div v-for="action in unsupported" :key="action">
          <dt>{{ extendedLabel(action) }}</dt>
          <dd>Não suportado</dd>
        </div>
      </dl>
    </template>
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
  border: 3px solid var(--state-error-color);
  color: var(--state-error-color);
}
:focus-visible {
  outline: 3px solid currentColor;
  outline-offset: 3px;
}
</style>
