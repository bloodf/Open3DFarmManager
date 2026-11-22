<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  parseStatusSummary,
  statusSummaryPath,
} from '../utils/status-summary.ts'
import { formatGrams } from '../utils/spool-features-format.ts'
import type {
  LowStockItem,
  LowStockResponse,
} from '../utils/spool-features-types.ts'
import type { LastKnownState } from '../composables/useLastKnownStates-core.ts'

const states = ref<LastKnownState[]>([])
const stock = ref<LowStockItem[] | null>(null)
const problem = ref('')
const loading = ref(true)
const observed = ref<number | null>(null)
let controller: AbortController | undefined
let timer: ReturnType<typeof setInterval> | undefined
const attention = computed(() =>
  states.value
    .filter((item) => ['error', 'paused', 'offline'].includes(item.state))
    .sort((a, b) => {
      const rank = { error: 0, paused: 1, offline: 2, printing: 3, idle: 4 }
      return rank[a.state] - rank[b.state] || a.observedAt - b.observedAt
    }),
)
const labels = {
  error: 'Erro',
  paused: 'Pausada',
  offline: 'Sem conexão',
  printing: 'Imprimindo',
  idle: 'Ociosa',
}
async function load() {
  controller?.abort()
  const request = (controller = new AbortController())
  try {
    const farms = await $fetch<{ farms: { farmId: string }[] }>('/api/farms', {
      signal: request.signal,
      retry: 0,
      timeout: 10000,
    })
    const id = farms.farms[0]?.farmId
    if (!id) {
      problem.value = 'Nenhuma farm disponível.'
      states.value = []
      stock.value = null
      return
    }
    const [summary, inventory] = await Promise.allSettled([
      $fetch<unknown>(statusSummaryPath(id), {
        signal: request.signal,
        retry: 0,
        timeout: 10000,
      }),
      $fetch<LowStockResponse>(
        `/api/farms/${encodeURIComponent(id)}/spool-library/low-stock`,
        { signal: request.signal, retry: 0, timeout: 10000 },
      ),
    ])
    if (request.signal.aborted) return
    const parsed =
      summary.status === 'fulfilled' ? parseStatusSummary(summary.value) : null
    if (!parsed?.ok) {
      states.value = []
      observed.value = null
      problem.value = 'Não foi possível consultar a situação das impressoras.'
    } else {
      states.value = parsed.summary.states
      observed.value = parsed.summary.generatedAt
      problem.value = parsed.summary.truncated
        ? 'Lista de impressoras incompleta.'
        : ''
    }
    stock.value =
      inventory.status === 'fulfilled' &&
      Array.isArray(inventory.value.filaments)
        ? inventory.value.filaments
            .filter((item) => item.low)
            .sort(
              (a, b) =>
                (a.remainingGrams ?? Infinity) - (b.remainingGrams ?? Infinity),
            )
        : null
  } catch {
    if (!request.signal.aborted) {
      states.value = []
      stock.value = null
      observed.value = null
      problem.value = 'Não foi possível consultar a farm.'
    }
  } finally {
    if (!request.signal.aborted) loading.value = false
  }
}
onMounted(() => {
  void load()
  timer = setInterval(load, 30000)
})
onBeforeUnmount(() => {
  controller?.abort()
  if (timer) clearInterval(timer)
})
</script>

<template>
  <main id="conteudo" class="control-room">
    <header role="presentation">
      <p class="eyebrow">Open3DFarmManager</p>
      <h1>Sala de controle</h1>
      <p>Prioridades da farm em um só lugar.</p>
    </header>
    <p v-if="loading" role="status">Consultando a farm…</p>
    <p v-if="problem" role="alert">
      {{ problem }}
      <button type="button" @click="load">Tentar novamente</button>
    </p>
    <p v-if="observed !== null" class="notice">
      Último resumo recebido:
      {{
        new Intl.DateTimeFormat('pt-BR', {
          dateStyle: 'short',
          timeStyle: 'short',
          timeZone: 'America/Sao_Paulo',
        }).format(observed)
      }}. Dados armazenados, sem conexão direta.
    </p>
    <div class="grid">
      <section aria-labelledby="attention">
        <h2 id="attention">Precisam de atenção</h2>
        <p>Erros, pausas e impressoras sem conexão, por prioridade.</p>
        <ul v-if="attention.length">
          <li v-for="item in attention" :key="item.assignmentId">
            <a :href="`/impressoras/${encodeURIComponent(item.printerKey)}`">{{
              item.displayName || item.printerKey
            }}</a><strong>{{ labels[item.state] }}</strong>
          </li>
        </ul>
        <p v-else>
          {{
            loading || problem
              ? 'Situação indisponível.'
              : 'Nenhuma impressora nesta lista.'
          }}
        </p>
        <NuxtLink to="/impressoras">Ver impressoras</NuxtLink>
      </section>
      <section aria-labelledby="finishes">
        <h2 id="finishes">Próximas 10 horas</h2>
        <p>As estimativas de término não estão disponíveis neste resumo.</p>
        <NuxtLink to="/farm">Ver situação da farm</NuxtLink>
      </section>
      <section aria-labelledby="stock">
        <h2 id="stock">Estoque baixo</h2>
        <p>Filamentos abaixo do limite, ordenados pela quantidade restante.</p>
        <ul v-if="stock?.length">
          <li v-for="item in stock" :key="item.filamentId">
            <NuxtLink to="/bobinas/estoque">{{
              item.name || `Filamento #${item.filamentId}`
            }}</NuxtLink><strong>{{
              item.remainingGrams === null
                ? 'Não informado'
                : formatGrams(item.remainingGrams)
            }}</strong>
          </li>
        </ul>
        <p v-else>
          {{
            stock === null
              ? 'Estoque indisponível.'
              : 'Nenhum filamento abaixo do limite.'
          }}
        </p>
        <NuxtLink to="/bobinas/estoque">Ver estoque</NuxtLink>
      </section>
    </div>
  </main>
</template>
<style scoped>
.control-room {
  display: grid;
  gap: var(--space-4);
  align-content: start;
}
header p,
h1,
h2,
section p {
  margin: 0;
}
header {
  display: grid;
  gap: var(--space-2);
}
.eyebrow,
.notice,
section p {
  color: var(--color-text-muted);
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr));
  gap: var(--space-4);
  align-items: start;
}
section {
  display: grid;
  gap: var(--space-3);
  min-width: 0;
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface-raised);
}
h2 {
  font-size: var(--font-size-lg);
}
ul {
  padding: 0;
  margin: 0;
  list-style: none;
}
li {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-3) 0;
  border-block-end: 1px solid var(--color-border);
  overflow-wrap: anywhere;
}
a:focus-visible,
button:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
</style>
