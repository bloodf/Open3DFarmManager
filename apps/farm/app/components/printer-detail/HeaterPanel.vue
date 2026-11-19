<script setup lang="ts">
import { computed, reactive } from 'vue'
import Button from '../ui/Button.vue'
import LineChart from '../ui/charts/LineChart.vue'
import Sparkline from '../ui/charts/Sparkline.vue'
import {
  clampTarget,
  commandHeaterName,
  heaterLabel,
  powerText,
  temperatureText,
  type HeaterHistory,
  type HeaterReading,
} from '../../utils/printer-detail-view.ts'

const props = defineProps<{
  heaters: readonly HeaterReading[]
  history: HeaterHistory
  /** False in degraded mode: values stay visible, commands stay off. */
  canCommand: boolean
  /** Why commands are off; shown next to the inputs. */
  disabledReason?: string
}>()
const emit = defineEmits<{
  (e: 'set-temperature', heater: string, targetC: number, event: Event): void
}>()

const drafts = reactive<Record<string, string>>({})
const notes = reactive<Record<string, string>>({})
const rows = computed(() =>
  props.heaters.map((heater, index) => ({
    ...heater,
    key: `heater-${index}`,
    label: heaterLabel(heater.name),
    points: (props.history[heater.name] ?? []).map(({ time, temperature }) => ({
      time,
      value: temperature,
    })),
  })),
)

function submit(heater: HeaterReading, event: Event) {
  if (!props.canCommand) return
  const target = clampTarget(drafts[heater.name] ?? '', heater.maxTemp)
  if (target === undefined) {
    notes[heater.name] = 'Informe uma temperatura válida em °C.'
    return
  }
  const clamped = String(target) !== (drafts[heater.name] ?? '').trim()
  drafts[heater.name] = String(target)
  notes[heater.name] = clamped
    ? `Valor ajustado ao limite de ${temperatureText(heater.maxTemp)}.`
    : ''
  emit('set-temperature', commandHeaterName(heater.name), target, event)
}
</script>

<template>
  <section aria-labelledby="heaters-title">
    <h2 id="heaters-title">Aquecedores</h2>
    <p v-if="!heaters.length">
      Nenhum aquecedor informado por esta impressora.
    </p>
    <p v-if="heaters.length && !canCommand" class="heater-note">
      {{ disabledReason ?? 'Somente leitura: sem conexão direta.' }}
    </p>
    <ul class="heaters">
      <li v-for="heater in rows" :key="heater.key" class="heater">
        <h3>{{ heater.label }}</h3>
        <dl>
          <dt>Atual</dt>
          <dd>
            {{ temperatureText(heater.temperature) }}
            <Sparkline
              :label="`Tendência de ${heater.label}`"
              :points="heater.points"
            />
          </dd>
          <dt>Alvo</dt>
          <dd>{{ temperatureText(heater.target) }}</dd>
          <dt>Potência</dt>
          <dd>{{ powerText(heater.power) }}</dd>
        </dl>
        <LineChart
          :label="`Temperatura de ${heater.label} nos últimos 10 minutos`"
          :series="[
            { label: 'Atual', color: 'currentColor', points: heater.points },
          ]"
          :targets="
            heater.target === undefined
              ? []
              : [{ label: 'Alvo', value: heater.target }]
          "
          unit="°C"
        />
        <form class="heater-set" @submit.prevent="submit(heater, $event)">
          <label :for="`${heater.key}-target`"
            >Nova temperatura de {{ heater.label }} (°C)</label
          >
          <input
            :id="`${heater.key}-target`"
            v-model="drafts[heater.name]"
            type="number"
            inputmode="numeric"
            min="0"
            :max="heater.maxTemp"
            step="1"
            :disabled="!canCommand"
            :aria-describedby="`${heater.key}-hint`"
          />
          <span :id="`${heater.key}-hint`">
            {{
              heater.maxTemp === undefined
                ? 'Limite não informado.'
                : `Máximo: ${temperatureText(heater.maxTemp)}.`
            }}
          </span>
          <Button type="submit" :disabled="!canCommand"
            >Definir {{ heater.label }}</Button
          >
          <p v-if="notes[heater.name]" role="status">
            {{ notes[heater.name] }}
          </p>
        </form>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.heaters {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr));
  gap: var(--space-4);
  padding: 0;
  list-style: none;
}
.heater {
  min-width: 0;
  border: 1px solid currentColor;
  border-radius: var(--radius-sm);
  padding: var(--space-4);
}
.heater dd {
  margin: 0 0 var(--space-2);
}
.heater-set {
  display: grid;
  gap: var(--space-2);
}
input {
  font: inherit;
  min-height: 2.75rem;
  max-width: 100%;
}
input:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-offset-compact);
}
</style>
