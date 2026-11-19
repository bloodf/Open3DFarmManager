<script setup lang="ts">
import { computed } from 'vue'
import {
  lastKnownStateAgeSeconds,
  type LastKnownState,
} from '../../composables/useLastKnownStates-core.ts'
import { formatPrinterStateLabel } from '../../utils/farm-view.ts'
import {
  KIOSK_STALE_SECONDS,
  clampKioskPage,
  kioskPageCount,
  kioskPageItems,
} from '../../utils/kiosk-wall.ts'

const props = withDefaults(
  defineProps<{
    states: readonly LastKnownState[]
    nowWallMs: number
    /** Wall time of the last successful poll, null before the first one. */
    fetchedAt: number | null
    /** The last poll failed; the states shown are the previous ones. */
    failed?: boolean
    page?: number
    perPage?: number
  }>(),
  { failed: false, page: 0, perPage: 12 },
)

const icons = {
  idle: '○',
  printing: '▶',
  paused: 'Ⅱ',
  error: '!',
  offline: '×',
}

const total = computed(() => kioskPageCount(props.states.length, props.perPage))
const current = computed(() =>
  clampKioskPage(props.page, props.states.length, props.perPage),
)
const fetchAge = computed(() =>
  props.fetchedAt === null
    ? null
    : lastKnownStateAgeSeconds(props.fetchedAt, props.nowWallMs),
)
// Unknown age counts as stale: a frozen screen must never look current.
const fetchStale = computed(
  () =>
    props.failed ||
    (props.fetchedAt !== null &&
      (fetchAge.value === null || fetchAge.value >= KIOSK_STALE_SECONDS)),
)
const cards = computed(() =>
  kioskPageItems(props.states, props.page, props.perPage).map((state) => {
    const age = lastKnownStateAgeSeconds(state.observedAt, props.nowWallMs)
    const stale = fetchStale.value || age === null || age >= KIOSK_STALE_SECONDS
    return {
      state,
      label: `${age === null ? 'Idade não confirmada' : `Observado há ${age} s`}${stale ? ' · Dados desatualizados' : ''}`,
      stale,
    }
  }),
)

const headLabel = computed(
  () =>
    `${fetchAge.value === null ? 'Idade dos dados indisponível' : `Dados atualizados há ${fetchAge.value} s`}${props.failed ? ' · Falha na atualização' : fetchStale.value ? ' · Dados desatualizados' : ''}`,
)

function temperature(value: number | undefined) {
  return value === undefined
    ? 'Indisponível'
    : `${value.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} °C`
}
</script>

<template>
  <section class="kiosk" aria-label="Painel das impressoras">
    <header class="kiosk__head">
      <h1>Painel das impressoras</h1>
      <p v-if="fetchedAt === null">Aguardando dados…</p>
      <p v-else :class="{ kiosk__warn: fetchStale }">{{ headLabel }}</p>
      <p v-if="total > 1">Página {{ current + 1 }} de {{ total }}</p>
    </header>
    <p v-if="!states.length && fetchedAt !== null" class="kiosk__empty">
      Nenhuma impressora com estado registrado.
    </p>
    <ul class="kiosk__grid">
      <li v-for="card in cards" :key="card.state.assignmentId">
        <article
          class="kiosk__card"
          :class="{ 'kiosk__card--stale': card.stale }"
        >
          <h2>{{ card.state.printerKey }}</h2>
          <p class="kiosk__state">
            <span aria-hidden="true">{{ icons[card.state.state] }}</span>
            {{ formatPrinterStateLabel(card.state) }}
          </p>
          <p v-if="card.state.progress !== undefined" class="kiosk__progress">
            {{ Math.round(card.state.progress * 100) }}%
          </p>
          <p>
            Bico {{ temperature(card.state.temperatures.toolCelsius) }} · Mesa
            {{ temperature(card.state.temperatures.bedCelsius) }}
          </p>
          <p class="kiosk__age">{{ card.label }}</p>
        </article>
      </li>
    </ul>
  </section>
</template>

<style>
.kiosk {
  display: flex;
  flex-direction: column;
  height: 100%;
  box-sizing: border-box;
  padding: 0.75rem 1rem;
  overflow: hidden;
}
.kiosk__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.25rem 1.5rem;
  min-height: 3rem;
}
.kiosk__head h1 {
  margin: 0;
  font-size: 1.5rem;
}
.kiosk__head p,
.kiosk__empty {
  margin: 0;
  font-size: 1.1rem;
}
.kiosk__warn {
  color: #ffb454;
  font-weight: 700;
}
.kiosk__grid {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 0.75rem;
  grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
  grid-auto-rows: minmax(11rem, 1fr);
  align-content: start;
}
.kiosk__card {
  height: 100%;
  box-sizing: border-box;
  border: 2px solid currentColor;
  border-radius: 0.75rem;
  padding: 0.75rem;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.kiosk__card--stale {
  border-style: dashed;
  opacity: 0.8;
}
.kiosk__card h2 {
  margin: 0;
  font-size: 1.4rem;
}
.kiosk__card p {
  margin: 0.25rem 0 0;
  font-size: 1rem;
}
.kiosk__state {
  font-size: 1.25rem;
  font-weight: 700;
}
.kiosk__progress {
  font-size: 1.6rem;
  font-weight: 700;
}
</style>
