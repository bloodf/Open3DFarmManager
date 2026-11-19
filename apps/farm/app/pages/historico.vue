<script setup lang="ts">
import Button from '../components/ui/Button.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import ErrorState from '../components/ui/ErrorState.vue'
import Skeleton from '../components/ui/Skeleton.vue'
import {
  jobHistoryRow,
  jobHistoryStatus,
  type JobHistoryItem,
} from '../utils/job-history-view.ts'

type Farm = { farmId: string }
const farms = ref<Farm[]>([])
const farmId = ref('')
const printerKey = ref('')
const jobs = ref<JobHistoryItem[]>([])
const nextBefore = ref<string | null>(null)
const pending = ref(true)
const error = ref('')
const errorSummary = ref<HTMLElement | null>(null)
let generation = 0
let controller: AbortController | undefined

const rows = computed(() => jobs.value.map(jobHistoryRow))
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
  farmId.value = farms.value.length === 1 ? (farms.value[0]?.farmId ?? '') : ''
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
  <main id="conteudo">
    <small>Open3DFarmManager</small>
    <h1>Histórico de trabalhos</h1>
    <p>
      Trabalhos finalizados registrados a partir da telemetria dos Connectors,
      do mais recente para o mais antigo.
    </p>
    <div ref="errorSummary" role="alert" tabindex="-1">
      <ErrorState
        v-if="error"
        title="Histórico indisponível"
        :description="error"
      >
        <Button @click="farmId ? loadJobs() : loadFarms()">
          Tentar novamente
        </Button>
        <NuxtLink to="/entrar">Entrar na conta</NuxtLink>
      </ErrorState>
    </div>
    <section aria-labelledby="filtros-heading" :aria-busy="pending">
      <h2 id="filtros-heading">Filtros</h2>
      <label for="farm">Farm</label>
      <select
        id="farm"
        v-model="farmId"
        :disabled="pending || !farms.length"
        @change="loadJobs()"
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
      <label for="printer">Impressora (opcional)</label>
      <input
        id="printer"
        v-model="printerKey"
        type="text"
        maxlength="128"
        autocomplete="off"
        :disabled="pending"
        @keydown.enter.prevent="loadJobs()"
      />
      <button type="button" :disabled="pending || !farmId" @click="loadJobs()">
        Atualizar histórico
      </button>
    </section>
    <div v-if="pending && !rows.length" aria-busy="true" class="loading">
      <p role="status">{{ status }}</p>
      <Skeleton /><Skeleton /><Skeleton />
    </div>
    <p v-else-if="pending" role="status">{{ status }}</p>
    <EmptyState
      v-else-if="!error && !rows.length"
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
    <table v-if="rows.length" aria-label="Trabalhos finalizados">
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
          <td>{{ row.printerKey }}</td>
          <td>{{ row.outcome }}</td>
          <td>{{ row.filename }}</td>
          <td>{{ row.endedAt }}</td>
          <td>{{ row.duration }}</td>
          <td>{{ row.library }}</td>
        </tr>
      </tbody>
    </table>
    <button
      v-if="nextBefore"
      type="button"
      :disabled="pending"
      @click="loadJobs(nextBefore)"
    >
      Carregar mais
    </button>
  </main>
</template>
<style scoped>
.loading {
  display: grid;
  gap: 0.75rem;
}
label {
  display: block;
  margin-top: 1rem;
}
button,
select,
input {
  min-height: 2.75rem;
}
table {
  border-collapse: collapse;
  margin-top: 1rem;
  width: 100%;
}
th,
td {
  border-bottom: 1px solid currentColor;
  padding: 0.5rem;
  text-align: left;
}
</style>
