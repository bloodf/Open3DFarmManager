<script setup lang="ts">
import {
  formatPercentage,
  formatTemperature,
  formatTime,
} from '../../utils/ui-format.ts'
import { computed } from 'vue'
import type { ActiveSpool } from '../../../../../packages/farm-protocol/src/status.ts'
import type { FarmAlert } from '../../utils/farm-alerts.ts'
import { farmJobView } from '../../utils/farm-job-view.ts'
import { farmSlotViews, type SlotBinding } from '../../utils/slot-spools.ts'
import FarmSlot from '../spool-art/FarmSlot.vue'
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
    bindings?: Readonly<Record<string, SlotBinding | undefined>>
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
  unknown: '?',
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
    label: formatTime(date),
  }
})

// Last-known materials are never drawn: a reel with an old colour and level
// would pass for the filament that is loaded now.
const slots = computed(() =>
  props.observation?.historical || age.value?.stale
    ? undefined
    : farmSlotViews(state.value?.materials, props.bindings, props.activeSpools),
)
const staleMaterials = computed(
  () =>
    !!(props.observation?.historical || age.value?.stale) &&
    !!state.value?.materials?.length,
)

function temperature(value: number | undefined) {
  return formatTemperature(value) ?? 'Indisponível'
}

const alertLabel = (alert: string | FarmAlert) =>
  typeof alert === 'string' ? alert : alert.label
const alertKey = (alert: string | FarmAlert) =>
  typeof alert === 'string' ? alert : alert.id
const alertKind = (alert: string | FarmAlert) =>
  typeof alert === 'string' ? undefined : alert.kind
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
    <p v-if="progress !== undefined">
      <progress
        :value="progress"
        max="100"
        aria-label="Progresso da impressão"
      />
      {{ formatPercentage(progress) }}
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
    <ul
      v-if="!embedded && slots?.length"
      class="wall-printer__slots"
      aria-label="Slots de filamento"
    >
      <li v-for="slot in slots" :key="slot.key">
        <FarmSlot
          :label="slot.label"
          :material="slot.material"
          :color="slot.color"
          :color-name="slot.color && `Cor ${slot.color}`"
          :printer-percent="slot.printerPercent"
          :spoolman-percent="slot.spoolmanPercent"
          :spoolman-remaining-weight="slot.spoolmanRemainingWeight"
          :spoolman-initial-weight="slot.spoolmanInitialWeight"
          :active="slot.active"
          :low="slot.low"
        >
          <template v-if="slot.active" #state>
            <strong>Em uso</strong>
          </template>
        </FarmSlot>
      </li>
    </ul>
    <p v-else-if="!embedded && staleMaterials" class="wall-printer__stale">
      Materiais indisponíveis: os dados estão desatualizados.
    </p>
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
.wall-printer img,
.wall-printer progress {
  max-width: 100%;
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
.wall-printer__slots {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 12rem), 1fr));
  gap: var(--ops-space-2);
  margin: 0.5rem 0;
  padding: 0;
  list-style: none;
}
.wall-printer__remaining {
  margin: 0;
}
.wall-printer__alerts {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  padding: 0;
  list-style: none;
}
</style>
