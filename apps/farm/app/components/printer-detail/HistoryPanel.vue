<script setup lang="ts">
import { computed, ref } from 'vue'
import Button from '../ui/Button.vue'
import type { JobHistoryItem } from '../../utils/job-history-view.ts'
import {
  durationText,
  filamentText,
  historyPage,
  mergeHistory,
  type PrinterHistoryJob,
  type PrinterHistoryTotals,
} from './history-view.ts'

const props = defineProps<{
  /** True only when the printer advertises the `job` capability. */
  advertised: boolean
  /** Catalog reason shown when the capability is not advertised. */
  disabledReason?: string
  /** The printer's own jobs from the `history` query. */
  jobs: readonly PrinterHistoryJob[]
  /** Totals from the `totals` query; null while unknown. */
  totals: PrinterHistoryTotals | null
  /** OpenFarm job history of this printer. */
  openfarmJobs: readonly JobHistoryItem[]
  /** A query is in flight. */
  pending?: boolean
  /** The query failed; stale data is not shown as current. */
  error?: string
  /** Replay link of a library version; the link shows only for linked jobs. */
  replayHref?: (librarySha256: string) => string | undefined
}>()

const requested = ref(1)
const rows = computed(() =>
  props.error ? [] : mergeHistory(props.jobs, props.openfarmJobs),
)
const view = computed(() => historyPage(rows.value, requested.value))
const totalRows = computed(() => [
  ['Trabalhos', String(props.totals?.jobs ?? 'Indisponível')],
  [
    'Tempo de impressão',
    props.totals ? durationText(props.totals.printSeconds) : 'Indisponível',
  ],
  [
    'Filamento',
    props.totals ? filamentText(props.totals.filamentMm) : 'Indisponível',
  ],
  [
    'Maior trabalho',
    props.totals?.longestJobSeconds === undefined
      ? 'Indisponível'
      : durationText(props.totals.longestJobSeconds),
  ],
])
</script>

<template>
  <section
    aria-labelledby="history-title"
    :aria-busy="pending ? 'true' : 'false'"
  >
    <h2 id="history-title">Histórico</h2>
    <p v-if="!advertised">
      {{ disabledReason ?? 'Esta impressora não anuncia este recurso.' }}
    </p>
    <template v-else>
      <p v-if="pending" role="status">Consultando histórico…</p>
      <p v-else-if="error" role="alert">{{ error }}</p>
      <template v-else>
        <h3 id="history-totals">Totais</h3>
        <dl aria-labelledby="history-totals" class="history-totals">
          <div v-for="[label, value] in totalRows" :key="label">
            <dt>{{ label }}</dt>
            <dd>{{ value }}</dd>
          </div>
        </dl>
        <p v-if="!rows.length" role="status">
          Nenhum trabalho finalizado registrado.
        </p>
        <template v-else>
          <div
            class="history-scroll"
            role="region"
            aria-label="Tabela de trabalhos finalizados"
            tabindex="0"
          >
            <table aria-label="Trabalhos finalizados desta impressora">
              <thead>
                <tr>
                  <th scope="col">Arquivo</th>
                  <th scope="col">Resultado</th>
                  <th scope="col">Término</th>
                  <th scope="col">Duração</th>
                  <th scope="col">Origem</th>
                  <th scope="col">Reimpressão</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in view.rows" :key="row.key">
                  <td>{{ row.filename }}</td>
                  <td>{{ row.outcome }}</td>
                  <td>{{ row.ended }}</td>
                  <td>{{ row.duration }}</td>
                  <td>{{ row.sourceLabel }}</td>
                  <td>
                    <a
                      v-if="
                        row.librarySha256 && replayHref?.(row.librarySha256)
                      "
                      :href="replayHref(row.librarySha256)"
                      :aria-label="`Imprimir de novo ${row.filename}`"
                      >Imprimir de novo</a
                    >
                    <template v-else>Sem vínculo com a biblioteca</template>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <nav v-if="view.pages > 1" aria-label="Páginas do histórico">
            <Button
              :disabled="view.page <= 1"
              @click="requested = view.page - 1"
              >Página anterior</Button
            >
            <span role="status"
              >Página {{ view.page }} de {{ view.pages }}</span
            >
            <Button
              :disabled="view.page >= view.pages"
              @click="requested = view.page + 1"
              >Próxima página</Button
            >
          </nav>
        </template>
      </template>
    </template>
  </section>
</template>

<style scoped>
.history-totals {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  gap: var(--space-2) var(--space-4);
}
.history-totals dd {
  margin: 0;
}
.history-scroll {
  overflow-x: auto;
}
.history-scroll:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-offset);
}
table {
  border-collapse: collapse;
  width: 100%;
}
th,
td {
  border-bottom: 1px solid currentColor;
  padding: var(--space-2);
  text-align: left;
}
</style>
