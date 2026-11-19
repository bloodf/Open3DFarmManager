<script setup lang="ts">
import { computed } from 'vue'
import type { ActiveSpool } from '../../../../../packages/farm-protocol/src/status.ts'
import type { FarmAlert } from '../../utils/farm-alerts.ts'
import { farmJobView } from '../../utils/farm-job-view.ts'
import { formatPercentage, formatTemperature } from '../../utils/ui-format.ts'
import ProgressRing from '../ui/charts/ProgressRing.vue'
import {
  formatPrinterStateLabel,
  observationAge,
  type FarmObservation,
} from '../../utils/farm-view.ts'

const props = withDefaults(
  defineProps<{
    name: string
    detailHref: string
    group?: string
    location?: string
    observation?: FarmObservation | null
    now: { wall: number; mono: number }
    nozzleTarget?: number
    bedTarget?: number
    thumbnailUrl?: string
    activeSpools?: readonly ActiveSpool[]
    /** Plain labels, or the farm alerts so each chip keeps its kind. */
    alerts?: readonly (string | FarmAlert)[]
    /** Heading level of the printer name, to fit the page outline. */
    headingLevel?: 2 | 3 | 4
    /** Inside another printer article: render a block, not a second article. */
    embedded?: boolean
  }>(),
  { headingLevel: 2, embedded: false },
)

const icons = {
  idle: '○',
  printing: '▶',
  paused: 'Ⅱ',
  error: '!',
  offline: '×',
}
const state = computed(() => props.observation?.state)
const job = computed(() => state.value && farmJobView(state.value))
const age = computed(
  () => props.observation && observationAge(props.observation, props.now),
)
const progress = computed(() =>
  state.value?.progress === undefined
    ? undefined
    : Math.round(state.value.progress * 100),
)
const finish = computed(() => {
  const remaining = state.value?.estimatedRemainingSeconds
  if (
    remaining === undefined ||
    state.value?.state !== 'printing' ||
    age.value?.stale ||
    !props.observation
  )
    return
  const date = new Date(
    (age.value?.sourceConfirmed
      ? state.value.observedAt
      : props.observation.received.wall) +
      remaining * 1000,
  )
  if (!Number.isFinite(date.getTime())) return
  return {
    datetime: date.toISOString(),
    label: date.toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
    }),
  }
})

function temperature(value: number | undefined) {
  return value === undefined
    ? 'Indisponível'
    : (formatTemperature(value) ?? 'Indisponível')
}

const alertLabel = (alert: string | FarmAlert) =>
  typeof alert === 'string' ? alert : alert.label
const alertKey = (alert: string | FarmAlert) =>
  typeof alert === 'string' ? alert : alert.id
const alertKind = (alert: string | FarmAlert) =>
  typeof alert === 'string' ? undefined : alert.kind

function spoolLabel(spool: ActiveSpool) {
  return (
    spool.name ||
    spool.material ||
    (spool.spoolId !== undefined ? `Carretel nº ${spool.spoolId}` : spool.slot)
  )
}
</script>

<template>
  <component :is="embedded ? 'div' : 'article'" class="wall-printer">
    <component :is="`h${headingLevel}`">
      <a :href="detailHref">{{ name }}</a>
    </component>
    <p v-if="group || location">
      {{ [group, location].filter(Boolean).join(' · ') }}
    </p>
    <p class="wall-printer__badge">
      <span aria-hidden="true">{{ state ? icons[state.state] : '?' }}</span>
      {{ state ? formatPrinterStateLabel(state) : 'Sem dados' }}
    </p>
    <p v-if="job?.filename">{{ job.filename }}</p>
    <img
      v-if="thumbnailUrl"
      :src="thumbnailUrl"
      alt="Miniatura da impressão"
      loading="lazy"
    />
    <p v-if="progress !== undefined" class="wall-printer__progress">
      <ProgressRing label="Progresso da impressão" :value="progress" />
      <span class="wall-printer__progress-text">{{
        formatPercentage(progress)
      }}</span>
    </p>
    <dl>
      <dt>Camada</dt>
      <dd>{{ job?.layer ?? 'Indisponível' }}</dd>
      <dt>Tempo restante</dt>
      <dd>{{ job?.remaining ?? 'Indisponível' }}</dd>
      <dt>Término previsto</dt>
      <dd>
        <time v-if="finish" :datetime="finish.datetime">{{
          finish.label
        }}</time><template v-else>Indisponível</template>
      </dd>
      <dt>Bico (atual / alvo)</dt>
      <dd>
        {{ temperature(state?.toolTemperatureCelsius) }} /
        {{ temperature(nozzleTarget) }}
      </dd>
      <dt>Mesa (atual / alvo)</dt>
      <dd>
        {{ temperature(state?.bedTemperatureCelsius) }} /
        {{ temperature(bedTarget) }}
      </dd>
    </dl>
    <ul v-if="state?.materials?.length" aria-label="Slots de filamento">
      <li v-for="material in state.materials" :key="material.slot">
        {{ material.slot
        }}<template v-if="material.materialType">
          · {{ material.materialType }}</template
        >
        <template v-if="material.colorHex">
          <span
            class="wall-printer__swatch"
            :style="{ backgroundColor: '#' + material.colorHex.slice(0, 6) }"
            aria-hidden="true"
          />
          <span class="wall-printer__color"
            >Cor #{{ material.colorHex.slice(0, 6) }}</span
          >
        </template>
        <template v-if="material.active"> · Em uso</template>
        <template v-if="material.remainingPercent !== undefined">
          · {{ material.remainingPercent }}% restante</template
        >
      </li>
    </ul>
    <ul v-if="activeSpools?.length" aria-label="Carretéis ativos">
      <li v-for="spool in activeSpools" :key="spool.slot">
        {{ spoolLabel(spool)
        }}<template v-if="spoolLabel(spool) !== spool.slot">
          · {{ spool.slot }}</template
        >
        <template v-if="spool.remainingPercent !== undefined">
          · {{ spool.remainingPercent }}% restante</template
        >
      </li>
    </ul>
    <ul v-if="alerts?.length" class="wall-printer__alerts" aria-label="Alertas">
      <li
        v-for="alert in alerts"
        :key="alertKey(alert)"
        class="wall-printer__badge"
        :data-alert-kind="alertKind(alert)"
      >
        {{ alertLabel(alert) }}
      </li>
    </ul>
    <p v-if="!age">Nenhuma atualização recebida</p>
    <p v-else>
      {{
        age.seconds === null
          ? 'Idade dos dados indisponível'
          : `Atualização recebida há ${age.seconds} s`
      }}
      <span v-if="age.stale"> · Dados desatualizados</span>
    </p>
  </component>
</template>

<style>
.wall-printer {
  border: 1px solid currentColor;
  border-radius: 0.75rem;
  padding: 1rem;
  min-width: 0;
  overflow-wrap: anywhere;
}
.wall-printer img {
  max-width: 100%;
}
.wall-printer__progress {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.wall-printer dd {
  margin: 0 0 0.5rem;
}
.wall-printer__badge {
  display: inline-block;
  border: 1px solid currentColor;
  border-radius: 0.5rem;
  padding: 0.125rem 0.5rem;
}
.wall-printer__swatch {
  display: inline-block;
  width: 1em;
  height: 1em;
  border: 1px solid currentColor;
  vertical-align: middle;
}
.wall-printer__color {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
.wall-printer__alerts {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  padding: 0;
  list-style: none;
}
</style>
