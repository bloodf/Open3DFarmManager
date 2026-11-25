<script setup lang="ts" generic="Row extends FarmRow">
import { formatPercentage, formatTemperature } from '../../utils/ui-format.ts'
import { computed, onMounted, ref } from 'vue'
import {
  formatPrinterAlarmLabel,
  formatPrinterOperationalStateLabel,
  observationAge,
  type FarmRow,
} from '../../utils/farm-view.ts'
import { formatJobTime } from '../../utils/farm-job-view.ts'
import { printerDetailHref } from '../../utils/farm-wall-card.ts'
import { farmSlotViews, type SlotBinding } from '../../utils/farm-slot-view.ts'
import FarmSpool from '../spool-art/FarmSpool.vue'

const props = defineProps<{
  farmId?: string
  rows: readonly Row[]
  bindingsFor?: (
    row: Row,
  ) => Readonly<Record<string, SlotBinding | undefined>> | undefined
  liveNow: () => { wall: number; mono: number }
}>()

const storageKey = 'openfarm:printer-wall-view'
const mode = ref('cards')
defineSlots<{ default(props: { rows: readonly Row[] }): unknown }>()

onMounted(() => {
  try {
    if (localStorage.getItem(storageKey) === 'table') mode.value = 'table'
  } catch {
    // The toggle still works when browser storage is blocked.
  }
})

function selectMode(value: 'cards' | 'table') {
  mode.value = value
  try {
    localStorage.setItem(storageKey, value)
  } catch {
    // The current view stays selected for this visit.
  }
}

const columns = [
  { label: 'Nome' },
  { label: 'Grupo' },
  { label: 'Localização' },
  { label: 'Estado' },
  {
    label: 'Progresso',
    format: (value: number) => `${Math.round(value * 100)}%`,
  },
  { label: 'Tempo restante', format: formatJobTime },
  { label: 'Bico', format: temperature },
  { label: 'Mesa', format: temperature },
  { label: 'Arquivo' },
  { label: 'Materiais' },
  { label: 'Bobinas' },
  { label: 'Alertas' },
  { label: 'Idade dos dados', format: (value: number) => `${value} s` },
]

const SPOOLS_COLUMN = columns.findIndex((column) => column.label === 'Bobinas')

function temperature(value: number) {
  return formatTemperature(value) ?? 'Indisponível'
}

const sort = ref({ index: 0, descending: false })
const collator = new Intl.Collator('pt-BR', { numeric: true })
const sortedRows = computed(() => {
  const now = props.liveNow()
  const { index, descending } = sort.value
  return props.rows
    .map((row) => {
      const state = row.observation?.state
      // Last-known materials are never drawn: stale colour and level would
      // pass for the filament that is loaded now.
      const spools = row.observation?.historical
        ? undefined
        : farmSlotViews(state?.materials, props.bindingsFor?.(row))
      const age = row.observation && observationAge(row.observation, now)
      const printerAlarms = formatPrinterAlarmLabel(state?.alarms)
      const alerts = [
        row.connection !== 'authenticated' && 'Sem conexão direta',
        age?.stale && 'Dados desatualizados',
        printerAlarms || (state?.state === 'error' && 'Erro na impressora'),
      ].filter(Boolean)
      const cells = [
        row.assignment.displayName || row.assignment.printerKey,
        row.assignment.groupName,
        row.assignment.location,
        state && formatPrinterOperationalStateLabel(state),
        state?.progress,
        state?.estimatedRemainingSeconds,
        state?.toolTemperatureCelsius,
        state?.bedTemperatureCelsius,
        state?.filename,
        row.observation?.historical
          ? undefined
          : state?.materials
              ?.map((material) => material.materialType || material.slot)
              .join(', '),
        spools?.length || undefined,
        alerts.length ? alerts.join(', ') : 'Nenhum',
        age?.seconds,
      ]
      return {
        id: row.assignment.assignmentId,
        printerKey: row.assignment.printerKey,
        spools,
        cells,
      }
    })
    .sort((a, b) => {
      const left = a.cells[index]
      const right = b.cells[index]
      if (left == null || left === '')
        return right == null || right === '' ? 0 : 1
      if (right == null || right === '') return -1
      const order =
        typeof left === 'number' && typeof right === 'number'
          ? left - right
          : collator.compare(String(left), String(right))
      return descending ? -order : order
    })
})

function sortBy(index: number) {
  sort.value = {
    index,
    descending: sort.value.index === index && !sort.value.descending,
  }
}

function display(value: string | number | null | undefined, index: number) {
  if (value == null || value === '') return 'Indisponível'
  return typeof value === 'number'
    ? (columns[index]?.format?.(value) ?? value)
    : value
}
</script>

<template>
  <div role="group" aria-label="Visualização das impressoras" class="actions">
    <button
      type="button"
      :aria-pressed="mode === 'cards'"
      @click="selectMode('cards')"
    >
      Cartões
    </button>
    <button
      type="button"
      :aria-pressed="mode === 'table'"
      @click="selectMode('table')"
    >
      Tabela
    </button>
  </div>
  <slot v-if="mode === 'cards'" :rows="rows" />
  <div
    v-else
    class="wall-scroll"
    role="region"
    tabindex="0"
    aria-label="Tabela de impressoras"
  >
    <table class="wall-table">
      <caption>
        Impressoras atribuídas
      </caption>
      <thead>
        <tr>
          <th
            v-for="(column, index) in columns"
            :key="column.label"
            scope="col"
            :aria-sort="
              sort.index === index
                ? sort.descending
                  ? 'descending'
                  : 'ascending'
                : undefined
            "
          >
            <button type="button" @click="sortBy(index)">
              {{ column.label }}
              <span v-if="sort.index === index" aria-hidden="true">{{
                sort.descending ? '↓' : '↑'
              }}</span>
            </button>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in sortedRows" :key="row.id">
          <th scope="row">
            <a :href="printerDetailHref(row.printerKey, farmId)">{{
              row.cells[0]
            }}</a>
          </th>
          <template v-for="index in columns.length - 1" :key="index">
            <td v-if="index === SPOOLS_COLUMN && row.spools?.length">
              <ul class="wall-spools" aria-label="Bobinas">
                <li v-for="spool in row.spools" :key="spool.key">
                  <FarmSpool
                    :color="spool.color"
                    :fraction="
                      spool.level.kind === 'known' ? spool.level.fraction : null
                    "
                    :size="32"
                  />
                  <span>
                    {{ spool.label }} · {{ spool.material }}
                    <template v-if="spool.level.kind === 'known'">
                      ·
                      {{ formatPercentage(spool.level.fraction * 100) }}
                      restante
                    </template>
                    <template v-if="!spool.color">
                      · Cor não informada</template
                    >
                  </span>
                </li>
              </ul>
            </td>
            <td v-else :class="{ numeric: [4, 5, 6, 7, 12].includes(index) }">
              {{ display(row.cells[index], index) }}
            </td>
          </template>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.wall-scroll {
  max-height: 65vh;
  overflow: auto;
}

.wall-table {
  width: 100%;
  border-spacing: 0;
  text-align: start;
}

.wall-table th,
.wall-table td {
  padding: 0.4rem 0.6rem;
  border-bottom: 1px solid currentColor;
  text-align: start;
  overflow-wrap: anywhere;
}

.wall-spools {
  display: grid;
  gap: 0.25rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.wall-spools li {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.wall-table .numeric {
  text-align: end;
  font-family: var(--ops-font-mono);
  font-variant-numeric: tabular-nums;
}

.wall-table thead th {
  position: sticky;
  top: 0;
  background: Canvas;
  color: CanvasText;
  white-space: nowrap;
}
</style>
