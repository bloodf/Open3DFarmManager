<script setup lang="ts">
import ReplayAction from '../components/history/ReplayAction.vue'
import { useReplayLive } from '../composables/useReplayLive.ts'
import {
  libraryReplayPrinters,
  libraryReplaySource,
  type LibraryReplayAssignment,
} from '../utils/library-replay.ts'
import type { LibraryVersion, PrinterProfile } from '../utils/library-view.ts'
import Button from '../components/ui/Button.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import ErrorState from '../components/ui/ErrorState.vue'
import Skeleton from '../components/ui/Skeleton.vue'
import StatusBadge from '../components/ui/StatusBadge.vue'
import {
  jobHistoryRow,
  jobHistoryStatus,
  type JobHistoryItem,
} from '../utils/job-history-view.ts'

const route = useRoute()
type Farm = { farmId: string }
const farms = ref<Farm[]>([])
const farmId = ref('')
const printerKey = ref('')
const outcome = ref('all')
const jobs = ref<JobHistoryItem[]>([])
const nextBefore = ref<string | null>(null)
const pending = ref(true)
const error = ref('')
const errorSummary = ref<HTMLElement | null>(null)
let generation = 0
let controller: AbortController | undefined

// Outcome tone reuses the printer-state colours; the label always carries it.
const outcomeTone = {
  completed: 'idle',
  cancelled: 'paused',
  failed: 'error',
} as const
const rows = computed(() =>
  jobs.value
    .filter((job) => outcome.value === 'all' || job.outcome === outcome.value)
    .map((job) => ({ ...jobHistoryRow(job), job })),
)
// Replay: printers and the live signed session are read when a row is opened.
const live = useReplayLive(farmId)
const assignments = ref<LibraryReplayAssignment[]>([])
const profiles = ref<PrinterProfile[]>([])
const replayPrinters = computed(() =>
  libraryReplayPrinters(assignments.value, profiles.value, live.liveFor),
)
const replayRequest = { retry: 0, timeout: 15_000 }
async function loadReplaySource(sha256: string) {
  const selected = farmId.value
  const base = `/api/farms/${selected}`
  const [found, printers, printerProfiles] = await Promise.all([
    $fetch<{ version: LibraryVersion }>(`${base}/library/replay-source`, {
      ...replayRequest,
      query: { sha256 },
    }),
    $fetch<{ printers: LibraryReplayAssignment[] }>(`${base}/printers`, {
      ...replayRequest,
      query: { limit: 50 },
    }),
    // Profiles only refine the compatibility check: replay works without them.
    $fetch<{ profiles: PrinterProfile[] }>(`${base}/printer-profiles`, {
      ...replayRequest,
      query: { limit: 50 },
    }).catch(() => ({ profiles: [] as PrinterProfile[] })),
  ])
  if (selected !== farmId.value || found.version.sha256 !== sha256)
    throw Error('Replay source changed')
  assignments.value = printers.printers
  profiles.value = printerProfiles.profiles
  return libraryReplaySource(found.version)
}
function changeFarm() {
  assignments.value = []
  profiles.value = []
  void loadJobs()
}
const status = computed(() =>
  jobHistoryStatus({
    pending: pending.value,
    error: error.value,
    count: jobs.value.length,
  }),
)
function cancel() {
  generation++
  controller?.abort()
  controller = undefined
}
function failure(cause: unknown) {
  const code =
    cause && typeof cause === 'object' && 'statusCode' in cause
      ? cause.statusCode
      : undefined
  return code === 401
    ? 'Sua sessão não está disponível. Entre novamente para consultar o histórico.'
    : 'Não foi possível consultar o histórico. Tente novamente.'
}
async function run<T>(request: (signal: AbortSignal) => Promise<T>) {
  cancel()
  const current = generation
  controller = new AbortController()
  pending.value = true
  error.value = ''
  try {
    const result = await request(controller.signal)
    return current === generation ? result : undefined
  } catch (cause) {
    if (current !== generation) return undefined
    // Never retain a stale authorized view after a failed request.
    jobs.value = []
    nextBefore.value = null
    error.value = failure(cause)
    await nextTick()
    errorSummary.value?.focus()
    return undefined
  } finally {
    if (current === generation) pending.value = false
  }
}
async function loadFarms() {
  const page = await run((signal) =>
    $fetch<{ farms: Farm[] }>('/api/farms', {
      query: { limit: 50 },
      signal,
      retry: 0,
      timeout: 15000,
    }),
  )
  farms.value = page?.farms ?? []
  const requested = route.query.farm
  farmId.value =
    farms.value.find((farm) => farm.farmId === requested)?.farmId ??
    (farms.value.length === 1 ? (farms.value[0]?.farmId ?? '') : '')
  if (farmId.value) await loadJobs()
}
async function loadJobs(before: string | null = null) {
  const selected = farmId.value
  if (!selected) {
    jobs.value = []
    nextBefore.value = null
    return
  }
  const page = await run((signal) =>
    $fetch<{ jobs: JobHistoryItem[]; nextBefore: string | null }>(
      '/api/job-history',
      {
        query: {
          farmId: selected,
          limit: 20,
          ...(before ? { before } : {}),
          ...(printerKey.value.trim()
            ? { printerKey: printerKey.value.trim() }
            : {}),
        },
        signal,
        retry: 0,
        timeout: 15000,
      },
    ),
  )
  if (!page || selected !== farmId.value) return
  jobs.value = before ? [...jobs.value, ...page.jobs] : page.jobs
  nextBefore.value = page.nextBefore
}
onMounted(() => void loadFarms())
onBeforeUnmount(cancel)
</script>

<template>
  <main id="conteudo" class="history-page">
    <header class="page-header" role="presentation">
      <p class="eyebrow">Open3DFarmManager</p>
      <h1>Histórico de trabalhos</h1>
      <p class="intro">
        Trabalhos finalizados registrados a partir da telemetria dos Connectors,
        do mais recente para o mais antigo.
      </p>
    </header>
    <div ref="errorSummary" class="alert" role="alert" tabindex="-1">
      <ErrorState
        v-if="error"
        title="Histórico indisponível"
        :description="error"
      >
        <div class="actions">
          <Button @click="farmId ? loadJobs() : loadFarms()">
            Tentar novamente
          </Button>
          <NuxtLink to="/entrar">Entrar na conta</NuxtLink>
        </div>
      </ErrorState>
    </div>
    <form
      class="filters"
      role="search"
      aria-labelledby="filtros-heading"
      :aria-busy="pending"
      @submit.prevent="loadJobs()"
    >
      <h2 id="filtros-heading">Filtros</h2>
      <div class="filter-grid">
        <div class="field">
          <label for="farm">Farm</label>
          <select
            id="farm"
            v-model="farmId"
            :disabled="pending || !farms.length"
            @change="changeFarm"
          >
            <option value="">Selecione</option>
            <option
              v-for="(farm, index) in farms"
              :key="farm.farmId"
              :value="farm.farmId"
            >
              Farm {{ index + 1 }} · {{ farm.farmId }}
            </option>
          </select>
        </div>
        <div class="field">
          <label for="printer">Impressora (opcional)</label>
          <input
            id="printer"
            v-model="printerKey"
            type="text"
            maxlength="128"
            autocomplete="off"
            :disabled="pending"
          />
        </div>
        <div class="field">
          <label for="outcome">Resultado dos trabalhos carregados</label>
          <select id="outcome" v-model="outcome">
            <option value="all">Todos</option>
            <option value="completed">Concluído</option>
            <option value="cancelled">Cancelado</option>
            <option value="failed">Falhou</option>
          </select>
        </div>
        <Button type="submit" :disabled="pending || !farmId">
          Atualizar histórico
        </Button>
      </div>
    </form>
    <div v-if="pending && !rows.length" aria-busy="true" class="loading panel">
      <p role="status">{{ status }}</p>
      <Skeleton /><Skeleton /><Skeleton />
    </div>
    <p v-else-if="pending" class="panel" role="status">{{ status }}</p>
    <EmptyState
      v-else-if="!error && !jobs.length"
      :title="
        farmId
          ? 'Nenhum trabalho finalizado'
          : farms.length
            ? 'Selecione uma farm'
            : 'Nenhuma farm disponível'
      "
      :description="
        farmId
          ? 'Quando uma impressora concluir, cancelar ou falhar em um trabalho, ele aparece aqui.'
          : farms.length
            ? 'Escolha uma farm nos filtros para consultar o histórico de trabalhos.'
            : 'Esta conta ainda não tem uma farm com trabalhos registrados.'
      "
    >
      <NuxtLink v-if="farmId" to="/impressoras">Ver impressoras</NuxtLink>
    </EmptyState>
    <section
      v-if="jobs.length"
      class="results"
      aria-labelledby="summary-heading"
    >
      <h2 id="summary-heading">Resultados dos trabalhos carregados</h2>
      <p class="count">
        Quantidade de trabalhos por resultado, nas páginas carregadas; não
        representa todo o histórico.
      </p>
      <ul class="summary-list">
        <li
          v-for="kind in ['completed', 'cancelled', 'failed'] as const"
          :key="kind"
        >
          {{
            {
              completed: 'Concluídos',
              cancelled: 'Cancelados',
              failed: 'Falharam',
            }[kind]
          }}:
          <strong
            >{{
              jobs.filter((job) => job.outcome === kind).length
            }}
            trabalhos</strong
          >
        </li>
      </ul>
    </section>
    <div v-if="jobs.length && !rows.length" class="panel">
      <p>Nenhum trabalho carregado corresponde ao resultado selecionado.</p>
      <Button
        v-if="nextBefore"
        :disabled="pending"
        @click="loadJobs(nextBefore)"
        >Carregar mais</Button
      >
    </div>
    <section
      v-if="rows.length"
      class="results"
      aria-labelledby="trabalhos-heading"
    >
      <h2 id="trabalhos-heading">Trabalhos</h2>
      <p class="count">
        {{ rows.length }} exibidos, do mais recente ao mais antigo.
      </p>
      <div
        class="table-scroll"
        role="region"
        aria-label="Tabela de trabalhos finalizados"
        tabindex="0"
      >
        <table aria-label="Trabalhos finalizados">
          <thead>
            <tr>
              <th scope="col">Impressora</th>
              <th scope="col">Resultado</th>
              <th scope="col">Arquivo</th>
              <th scope="col">Término</th>
              <th scope="col">Duração</th>
              <th scope="col">Biblioteca</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.id">
              <td class="wrap">{{ row.printerKey }}</td>
              <td>
                <StatusBadge
                  :tone="outcomeTone[row.job.outcome]"
                  :label="row.outcome"
                />
              </td>
              <td class="wrap">{{ row.filename }}</td>
              <td class="nowrap">{{ row.endedAt }}</td>
              <td class="nowrap">{{ row.duration }}</td>
              <td>
                <div class="library">
                  <span class="wrap">{{ row.library }}</span>
                  <ReplayAction
                    v-if="row.job.librarySha256"
                    :key="`${farmId}:${row.id}`"
                    :job="row.job"
                    :load-source="
                      () => loadReplaySource(row.job.librarySha256!)
                    "
                    :printers="replayPrinters"
                    :send="live.send"
                  />
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="nextBefore" class="more">
        <Button :disabled="pending" @click="loadJobs(nextBefore)">
          Carregar mais
        </Button>
      </div>
    </section>
  </main>
</template>
<style scoped>
.history-page {
  display: grid;
  gap: var(--space-4);
  align-content: start;
}
.page-header {
  display: grid;
  gap: var(--space-2);
}
.eyebrow {
  margin: 0;
  font-size: var(--font-size-sm);
  letter-spacing: 0.04em;
  color: var(--color-text-muted);
}
.page-header h1 {
  margin: 0;
  overflow-wrap: anywhere;
}
.intro {
  margin: 0;
  color: var(--color-text-muted);
}
.alert:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
  border-radius: var(--radius-md);
}
.alert:empty {
  display: none;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
  align-items: center;
}
.panel,
.filters,
.results {
  margin: 0;
  padding: var(--space-5);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  min-width: 0;
}
.panel p {
  margin: 0;
}
h2 {
  margin: 0 0 var(--space-3);
  font-size: var(--font-size-lg);
  line-height: var(--line-height-tight);
}
.filter-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr));
  gap: var(--space-3) var(--space-4);
  align-items: end;
}
.field {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
}
label {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
}
select,
input {
  width: 100%;
  min-height: 2.75rem;
  padding: var(--space-2) var(--space-3);
  font: inherit;
  color: inherit;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}
select:focus-visible,
input:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
select:disabled,
input:disabled {
  opacity: 0.6;
}
.loading {
  display: grid;
  gap: var(--space-3);
}
.summary-list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-4);
  padding: 0;
  list-style: none;
}
.count {
  margin: 0 0 var(--space-3);
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}
.table-scroll {
  overflow-x: auto;
  max-inline-size: 100%;
}
.table-scroll:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
table {
  border-collapse: collapse;
  width: 100%;
  min-width: 46rem;
}
th,
td {
  padding: var(--space-3) var(--space-2);
  text-align: start;
  vertical-align: top;
  border-block-end: 1px solid var(--color-border);
}
th {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  white-space: nowrap;
}
tbody tr:last-child td {
  border-block-end: 0;
}
.wrap {
  overflow-wrap: anywhere;
  min-width: 8rem;
}
.nowrap {
  white-space: nowrap;
}
.library {
  display: grid;
  gap: var(--space-2);
  justify-items: start;
}
/* Same bordered surface as the filters and results panels. */
.history-page :deep(.ui-card) {
  border: 1px solid var(--color-border);
  box-shadow: none;
}
.more {
  display: flex;
  justify-content: center;
  margin-top: var(--space-4);
}
@media (max-width: 30rem) {
  .panel,
  .filters,
  .results {
    padding: var(--space-4);
  }
}
</style>
