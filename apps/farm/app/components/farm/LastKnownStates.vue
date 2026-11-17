<script setup lang="ts">
import { computed } from 'vue'
import {
  OFFLINE_CONNECTION_LABEL,
  lastKnownStateAgeLabel,
  type LastKnownState,
} from '../../utils/last-known-states.ts'
import { printerStateLabel } from '../../utils/farm-view.ts'

const props = defineProps<{
  state: LastKnownState
  nowWallMs: number
}>()

/**
 * One clock reading for the whole card: the age label and the observation
 * instant never disagree because they were taken apart.
 */
const observed = computed(() => ({
  age: lastKnownStateAgeLabel(props.state.observedAt, props.nowWallMs),
}))

function temperatureLabel(value: number | undefined): string {
  return value === undefined
    ? 'Indisponível'
    : `${value.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} °C`
}
</script>

<template>
  <article
    class="last-known-state"
    :aria-labelledby="`last-known-${state.assignmentId}`"
  >
    <h3 :id="`last-known-${state.assignmentId}`" class="opaque">
      {{ state.printerKey }}
    </h3>
    <p class="offline-label">
      <span aria-hidden="true">⚠</span>
      <span>
        Última observação conhecida — {{ OFFLINE_CONNECTION_LABEL }}
      </span>
    </p>
    <dl>
      <dt>Estado informado</dt>
      <dd>{{ printerStateLabel[state.state] }}</dd>
      <dt>Idade da observação</dt>
      <dd>{{ observed.age }}</dd>
      <dt>Temperatura do bico</dt>
      <dd>{{ temperatureLabel(state.temperatures.toolCelsius) }}</dd>
      <dt>Temperatura da mesa</dt>
      <dd>{{ temperatureLabel(state.temperatures.bedCelsius) }}</dd>
    </dl>
    <p v-if="state.progress !== undefined">
      Progresso informado da impressão:
      {{ Math.round(state.progress * 100) }}%
    </p>
    <p class="opaque">
      Somente leitura: sem conexão direta, nenhum comando é enviado a esta
      impressora.
    </p>
  </article>
</template>

<style scoped>
.last-known-state {
  border: 1px solid currentColor;
  padding: 1rem;
  margin: 1rem 0;
  min-width: 0;
}
.offline-label {
  font-weight: 600;
}
dt {
  font-weight: 600;
  margin-top: 0.75rem;
}
dd {
  margin: 0.25rem 0 0;
}
h3 {
  margin: 0 0 0.75rem;
}
.opaque {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: normal;
}
</style>
