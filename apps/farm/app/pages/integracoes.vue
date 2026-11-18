<script setup lang="ts">
type AuditEntry = {
  id: string
  appId: string | null
  printerAssignmentId: string | null
  actorKind: string
  action: string
  resourceId: string | null
  outcome: string
  occurredAt: number
  details: Record<string, string | number | boolean | null>
}
type FarmList = { farms: { farmId: string }[] }
type AuditPage = { entries: AuditEntry[]; nextCursor: string | null }
const farmId = ref('')
const appId = ref('')
const printerId = ref('')
const entries = ref<AuditEntry[]>([])
const error = ref('')
const loading = ref(false)
async function load() {
  loading.value = true
  error.value = ''
  try {
    if (!farmId.value) {
      const farms = await $fetch<FarmList>('/api/farms', { retry: 0 })
      farmId.value = farms.farms[0]?.farmId ?? ''
    }
    if (!farmId.value) {
      entries.value = []
      return
    }
    const result = await $fetch<AuditPage>(
      `/api/farms/${farmId.value}/integrations/audit`,
      {
        query: {
          ...(appId.value ? { appId: appId.value } : {}),
          ...(printerId.value ? { printerId: printerId.value } : {}),
        },
        retry: 0,
      },
    )
    entries.value = result.entries
  } catch (cause) {
    entries.value = []
    const status =
      cause && typeof cause === 'object' && 'statusCode' in cause
        ? cause.statusCode
        : 0
    error.value =
      status === 401 || status === 403
        ? 'Entre como proprietária da farm para consultar o registro.'
        : 'Não foi possível carregar o registro de atividades.'
  } finally {
    loading.value = false
  }
}
function timestamp(value: number) {
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(value)
}
onMounted(load)
</script>
<template>
  <main>
    <h1>Integrações</h1>
    <section aria-labelledby="audit-heading">
      <h2 id="audit-heading">Registro de atividades</h2>
      <p>
        Consulte ações realizadas por aplicativos e os resultados informados
        pelos Connectors.
      </p>
      <form @submit.prevent="load">
        <label for="app-filter">Aplicativo (ID)</label>
        <input id="app-filter" v-model.trim="appId" autocomplete="off" />
        <label for="printer-filter">Impressora (ID)</label>
        <input
          id="printer-filter"
          v-model.trim="printerId"
          autocomplete="off"
        />
        <button type="submit" :disabled="loading">Filtrar</button>
      </form>
      <p v-if="error" role="alert">{{ error }}</p>
      <p v-else-if="loading" role="status">Carregando atividades…</p>
      <p v-else-if="entries.length === 0">Nenhuma atividade registrada.</p>
      <div
        v-else
        class="table-scroll"
        tabindex="0"
        aria-label="Tabela de atividades; role horizontalmente para consultar todas as colunas"
      >
        <table>
          <caption>
            Atividades recentes das integrações
          </caption>
          <thead>
            <tr>
              <th scope="col">Data e hora</th>
              <th scope="col">Aplicativo</th>
              <th scope="col">Impressora</th>
              <th scope="col">Ação</th>
              <th scope="col">Resultado</th>
              <th scope="col">Ator</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in entries" :key="entry.id">
              <td>{{ timestamp(entry.occurredAt) }}</td>
              <td>{{ entry.appId ?? '—' }}</td>
              <td>{{ entry.printerAssignmentId ?? '—' }}</td>
              <td>{{ entry.action }}</td>
              <td>{{ entry.outcome }}</td>
              <td>{{ entry.actorKind }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <button v-if="entries.length" type="button" @click="load">
        Atualizar
      </button>
    </section>
  </main>
</template>
<style scoped>
main {
  max-width: 72rem;
  margin: 0 auto;
  padding: 1.5rem;
}
form {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: 0.75rem;
  margin: 1rem 0;
}
label {
  display: grid;
  gap: 0.25rem;
}
input,
button {
  min-height: 2.75rem;
  padding: 0.5rem;
}
.table-scroll {
  overflow-x: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
}
th,
td {
  padding: 0.65rem;
  text-align: start;
  border-bottom: 1px solid currentColor;
}
:focus-visible {
  outline: 3px solid currentColor;
  outline-offset: 2px;
}
</style>
