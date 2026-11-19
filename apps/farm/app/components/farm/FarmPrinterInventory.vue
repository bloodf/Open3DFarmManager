<script setup lang="ts">
import type { ExtendedControlAction } from '../../../../../packages/farm-protocol/src/control-actions.ts'
import type { FarmFilter, FarmSort } from '../../utils/farm-filters.ts'
import type { FarmKeyState, FarmRow } from '../../utils/farm-view.ts'
import FarmPrinterCard from './FarmPrinterCard.vue'
import FarmPrinterFilters from './FarmPrinterFilters.vue'

const query = defineModel<string>('query', { required: true })
const filter = defineModel<FarmFilter>('filter', { required: true })
const sort = defineModel<FarmSort>('sort', { required: true })

defineProps<{
  farmId: string
  inventory: 'loading' | 'ready'
  printerAfter: string | null
  nextPrinter: string | null
  rows: FarmRow[]
  renderedRows: readonly (FarmRow & {
    draft?: { value: string; confirmed: boolean; error: string }
  })[]
  keys: FarmKeyState
  controlEnabled: boolean
  commandInFlight: boolean
  now: { wall: number; mono: number }
  lastControlResults: Record<string, string>
  connectionText: (row: FarmRow) => string
  pauseAvailability: (row: FarmRow) => {
    available: boolean
    reason?: string
  }
  cameraFor: (assignmentId: string) => MediaStream | null
  liveNow: () => { wall: number; mono: number }
}>()

const emit = defineEmits<{
  refresh: []
  firstPage: []
  nextPage: [after: string]
  resetFilters: []
  action: [
    row: FarmRow,
    action: ExtendedControlAction,
    args: Record<string, unknown>,
    event: Event,
  ]
  pause: [row: FarmRow, event: Event]
  setupOrigin: [assignmentId: string]
  saveOrigin: [assignmentId: string]
  cancelOrigin: [assignmentId: string]
}>()
</script>

<template>
  <section
    aria-labelledby="printers-heading"
    :aria-busy="inventory === 'loading'"
  >
    <h2 id="printers-heading">Impressoras atribuídas</h2>
    <p>
      O cadastro informa atribuições e aprovações. O estado da impressora
      depende da conexão direta.
    </p>
    <p v-if="inventory === 'loading'" role="status">
      Carregando o cadastro de impressoras…
    </p>
    <template v-else>
      <div class="actions">
        <button type="button" @click="emit('refresh')">
          Atualizar cadastro
        </button>
        <button v-if="printerAfter" type="button" @click="emit('firstPage')">
          Primeira página de atribuições
        </button>
        <button
          v-if="nextPrinter"
          type="button"
          @click="emit('nextPage', nextPrinter)"
        >
          Próximas atribuições
        </button>
      </div>
      <p v-if="printerAfter">Exibindo outra página de atribuições.</p>
      <p v-if="!rows.length">
        {{
          printerAfter || nextPrinter
            ? 'Nenhuma atribuição nesta página.'
            : 'Nenhuma impressora atribuída a esta farm.'
        }}
        <NuxtLink to="/impressoras">Gerenciar atribuições</NuxtLink>
      </p>
      <FarmPrinterFilters
        v-model:query="query"
        v-model:filter="filter"
        v-model:sort="sort"
        :rendered-count="renderedRows.length"
        :total-count="rows.length"
        @reset="emit('resetFilters')"
      />
      <ul class="printers">
        <li v-for="row in renderedRows" :key="row.assignment.assignmentId">
          <FarmPrinterCard
            :row="row"
            :farm-id="farmId"
            :keys="keys"
            :control-enabled="controlEnabled"
            :command-in-flight="commandInFlight"
            :now="liveNow()"
            :last-result="lastControlResults[row.assignment.assignmentId]"
            :pause-available="pauseAvailability(row).available"
            :pause-reason="pauseAvailability(row).reason ?? ''"
            :camera-stream="cameraFor(row.assignment.assignmentId)"
            :connection-text="connectionText(row)"
            @action="
              (action, args, event) => emit('action', row, action, args, event)
            "
            @pause="emit('pause', row, $event)"
            @setup-origin="emit('setupOrigin', $event)"
            @save-origin="emit('saveOrigin', $event)"
            @cancel-origin="emit('cancelOrigin', $event)"
          />
        </li>
      </ul>
    </template>
  </section>
</template>
