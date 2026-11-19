<script setup lang="ts">
import { computed } from 'vue'
import { farmStateLabels } from '../../utils/farm-filters.ts'
import { KIOSK_STALE_SECONDS } from '../../utils/kiosk-wall.ts'
import type { StatusSummaryView } from '../../utils/status-summary.ts'
import StaleNotice from '../ui/StaleNotice.vue'

const props = defineProps<{
  summary: StatusSummaryView | null
  /** Wall time of the last successful read, null before the first one. */
  fetchedAt: number | null
  /** The last read failed; the counts shown are the previous ones. */
  failed?: boolean
  nowWallMs: number
}>()

const states = ['printing', 'idle', 'paused', 'error', 'offline'] as const
const age = computed(() =>
  props.fetchedAt === null || props.nowWallMs < props.fetchedAt
    ? null
    : Math.floor((props.nowWallMs - props.fetchedAt) / 1000),
)
// An unknown age counts as stale: a frozen summary must never look current.
const stale = computed(
  () =>
    props.failed ||
    (props.fetchedAt !== null &&
      (age.value === null || age.value >= KIOSK_STALE_SECONDS)),
)
</script>

<template>
  <section
    v-if="summary || failed"
    aria-labelledby="wall-summary-heading"
    class="wall-summary"
  >
    <h2 id="wall-summary-heading">Resumo da farm</h2>
    <template v-if="summary">
      <p>
        {{ summary.total }}
        {{ summary.total === 1 ? 'impressora' : 'impressoras' }} na farm.
        <template v-if="summary.truncated">
          Exibindo as primeiras {{ summary.states.length }}.
        </template>
      </p>
      <ul aria-label="Impressoras da farm por estado">
        <li v-for="state in states" :key="state">
          {{ farmStateLabels[state] }}: {{ summary.counts[state] }}
        </li>
      </ul>
      <p v-if="age !== null && !stale">Resumo atualizado há {{ age }} s.</p>
    </template>
    <StaleNotice
      v-if="stale"
      :role="null"
      :title="summary ? undefined : 'Resumo indisponível'"
      :description="
        !summary
          ? 'Não foi possível carregar o resumo da farm.'
          : failed
            ? 'Não foi possível atualizar o resumo. Estes são os últimos valores recebidos.'
            : `O resumo não é atualizado há ${age ?? 'mais de 30'} s.`
      "
    />
  </section>
</template>

<style scoped>
.wall-summary ul {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 1rem;
  padding: 0;
  list-style: none;
}
</style>
