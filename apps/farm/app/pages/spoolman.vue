<script setup lang="ts">
import { resolveFarmScope } from '../utils/farm-scope.ts'
import { fetchFarmMemberships } from '../composables/useFarmMemberships.ts'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import Button from '../components/ui/Button.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import ErrorState from '../components/ui/ErrorState.vue'
import Skeleton from '../components/ui/Skeleton.vue'
import SpoolmanForm from '../components/spoolman/SpoolmanForm.vue'
import SpoolmanResults, {
  type SpoolmanSavedSetting,
} from '../components/spoolman/SpoolmanResults.vue'
import {
  configureSpoolmanOnConnectors,
  validateSpoolmanTargetInput,
  type SpoolmanConnectorResult,
} from '../utils/spoolman-onboarding.ts'
import {
  describeSpoolmanKeyState,
  loadSpoolmanBrowserKey,
  openSpoolmanSession,
  type SpoolmanKeyState,
} from '../utils/spoolman-setup-context.ts'

definePageMeta({
  key: (route) => JSON.stringify([route.path, { farm: route.query.farm }]),
})

type Connector = { agentId: string; status: 'pending' | 'approved' | 'revoked' }

const route = useRoute()
const farmId = ref('')
const connectors = ref<Connector[]>([])
const settings = ref<SpoolmanSavedSetting[]>([])
const canManage = ref(false)
const keyState = ref<SpoolmanKeyState>({
  kind: 'unavailable',
  reason: 'missing',
})
const results = ref<SpoolmanConnectorResult[]>([])
const loading = ref(true)
const busy = ref(false)
const error = ref('')
// Fixed pt-BR copy for the failed page load, shown as ErrorState with retry.
const loadError = ref('')
const signInRequired = ref(false)
const noFarm = ref(false)
const hasMemberships = ref(false)
const status = ref('')
const errorSummary = ref<HTMLElement | null>(null)
const origin = ref('')
const token = ref('')
const username = ref('')
const password = ref('')
let controller: AbortController | undefined

const approved = computed(() =>
  connectors.value.filter((connector) => connector.status === 'approved'),
)

function clearSecrets() {
  token.value = ''
  username.value = ''
  password.value = ''
}

async function fail(message: string) {
  error.value = message
  await nextTick()
  errorSummary.value?.focus()
}

async function refresh() {
  if (!farmId.value) return
  const signal = (controller = new AbortController()).signal
  const [list, inventory] = await Promise.all([
    $fetch<{ settings: SpoolmanSavedSetting[]; canManage: boolean }>(
      `/api/farms/${farmId.value}/spoolman`,
      { retry: 0, timeout: 15_000, signal },
    ),
    $fetch<{ connectors: Connector[] }>(
      `/api/farms/${farmId.value}/connectors`,
      { retry: 0, timeout: 15_000, signal },
    ),
  ])
  settings.value = list.settings
  canManage.value = list.canManage
  connectors.value = inventory.connectors
  if (list.canManage)
    keyState.value = await loadSpoolmanBrowserKey(farmId.value, signal)
}

async function load() {
  loading.value = true
  loadError.value = ''
  signInRequired.value = false
  error.value = ''
  noFarm.value = false
  try {
    const memberships = await fetchFarmMemberships({ timeout: 15_000 })
    hasMemberships.value = memberships.length > 0
    farmId.value = resolveFarmScope(memberships, route.query.farm)?.farmId ?? ''
    if (!farmId.value) noFarm.value = true
    else await refresh()
  } catch (cause) {
    const code =
      cause && typeof cause === 'object' && 'statusCode' in cause
        ? cause.statusCode
        : undefined
    signInRequired.value = code === 401
    loadError.value =
      code === 401
        ? 'Entre na sua conta para configurar o Spoolman.'
        : 'Não foi possível carregar o Spoolman. Tente novamente.'
    await nextTick()
    errorSummary.value?.focus()
  } finally {
    loading.value = false
  }
}

onMounted(load)
onBeforeUnmount(() => {
  controller?.abort()
  clearSecrets()
})

async function submit() {
  if (busy.value || !farmId.value) return
  error.value = ''
  status.value = ''
  if (keyState.value.kind !== 'available')
    return fail(describeSpoolmanKeyState(keyState.value))
  const validated = validateSpoolmanTargetInput({
    origin: origin.value,
    token: token.value,
    username: username.value,
    password: password.value,
  })
  // Secrets live only inside `target` for the duration of the call.
  clearSecrets()
  if (!validated.ok) return fail(validated.error)
  busy.value = true
  results.value = []
  const key = keyState.value.key
  const farm = farmId.value
  const signal = (controller = new AbortController()).signal
  try {
    await configureSpoolmanOnConnectors({
      target: validated.target,
      agentIds: approved.value.map((connector) => connector.agentId),
      signal,
      openSession: (agentId, sessionSignal) =>
        openSpoolmanSession(farm, key, agentId, sessionSignal),
      report: async (result) => {
        await $fetch(`/api/farms/${farm}/spoolman`, {
          method: 'PUT',
          body: result,
          retry: 0,
          timeout: 15_000,
        })
      },
      onResult: (result) => {
        results.value = [...results.value, result]
      },
    })
    await refresh()
    status.value = 'Teste concluído. Veja o resultado de cada Connector abaixo.'
  } catch {
    await fail('Não foi possível concluir a configuração. Tente novamente.')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <main class="spoolman-page">
    <header class="page-header">
      <h1>Spoolman da farm</h1>
      <p class="intro">
        Configure um Spoolman para toda a farm. O endereço é enviado aos
        Connectors aprovados; as credenciais ficam somente neles.
      </p>
    </header>
    <div v-if="loading" aria-busy="true" class="loading panel">
      <p role="status">Carregando o Spoolman…</p>
      <Skeleton /><Skeleton /><Skeleton />
    </div>
    <div
      v-if="error || loadError"
      ref="errorSummary"
      role="alert"
      tabindex="-1"
      class="spoolman-error"
    >
      <ErrorState
        v-if="loadError"
        title="Spoolman indisponível"
        :description="loadError"
      >
        <div class="actions">
          <Button @click="load()">Tentar novamente</Button>
          <NuxtLink v-if="signInRequired" to="/entrar" class="cta"
            >Entrar</NuxtLink
          >
        </div>
      </ErrorState>
      <template v-else>{{ error }}</template>
    </div>
    <EmptyState
      v-if="noFarm"
      :title="hasMemberships ? 'Selecione uma farm' : 'Nenhuma farm disponível'"
      :description="
        hasMemberships
          ? 'Escolha uma farm para continuar.'
          : 'Crie uma farm ou solicite acesso à pessoa responsável.'
      "
    >
      <NuxtLink to="/farm" class="cta">Ir para farms</NuxtLink>
    </EmptyState>
    <p v-if="status" role="status" class="notice">{{ status }}</p>
    <div v-if="!loading && farmId && !loadError" class="layout">
      <section class="panel" aria-labelledby="spoolman-config-heading">
        <h2 id="spoolman-config-heading">Conectar o Spoolman</h2>
        <p v-if="!canManage" role="status" class="notice">
          Apenas proprietários e administradores configuram o Spoolman. Você
          pode consultar a situação abaixo.
        </p>
        <SpoolmanForm
          v-else
          v-model:origin="origin"
          v-model:token="token"
          v-model:username="username"
          v-model:password="password"
          :busy="busy"
          :connector-count="approved.length"
          @submit="submit"
        />
      </section>
      <div class="results">
        <SpoolmanResults
          :settings="settings"
          :results="results"
          :can-manage="canManage"
        />
      </div>
    </div>
  </main>
</template>

<style scoped>
.spoolman-page {
  display: grid;
  gap: var(--space-4);
  align-content: start;
}
.page-header {
  display: grid;
  gap: var(--space-2);
}
.page-header h1 {
  margin: 0;
  max-width: 40rem;
  overflow-wrap: anywhere;
}
.intro {
  margin: 0;
  max-width: 40rem;
  color: var(--color-text-muted);
}
.panel,
.results > :deep(section) {
  display: grid;
  gap: var(--space-3);
  align-content: start;
  min-width: 0;
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
}
.panel h2,
.results :deep(h2) {
  margin: 0;
  font-size: var(--font-size-lg);
  line-height: var(--line-height-tight);
}
.panel p,
.results :deep(p) {
  margin: 0;
}
.loading {
  gap: var(--space-3);
}
.loading :deep(.skeleton) {
  min-block-size: var(--space-5);
}
.layout {
  display: grid;
  gap: var(--space-4);
  align-items: start;
  min-width: 0;
}
.results {
  display: grid;
  gap: var(--space-4);
  min-width: 0;
}
.notice,
.spoolman-error {
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--color-border);
  border-inline-start: var(--space-1) solid var(--color-accent);
  border-radius: var(--radius-sm);
  background: var(--color-surface-raised);
}
.spoolman-error {
  border-inline-start-color: var(--printer-error);
  overflow-wrap: anywhere;
}
.spoolman-error:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.spoolman-error :deep(.ui-card),
.panel :deep(.ui-card),
.results :deep(.ui-card),
.spoolman-page > :deep(.ui-card) {
  padding: 0;
  box-shadow: none;
  background: transparent;
}
.spoolman-page > :deep(.ui-card) {
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
}
.spoolman-page :deep(.ui-card h2),
.spoolman-page :deep(.ui-card h3) {
  margin: 0 0 var(--space-2);
  font-size: var(--font-size-lg);
  line-height: var(--line-height-tight);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: center;
  margin-top: var(--space-3);
}
.cta {
  display: inline-flex;
  align-items: center;
  min-height: 2.75rem;
  padding: var(--space-2) var(--space-4);
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-sm);
  font-weight: var(--font-weight-semibold);
}

/* SpoolmanForm: stacked, labelled, touch-sized controls. */
.panel :deep(.spoolman-form) {
  display: grid;
  max-width: 32rem;
  gap: var(--space-2);
}
.panel :deep(.spoolman-form label) {
  margin-top: var(--space-2);
  font-weight: var(--font-weight-semibold);
}
.panel :deep(.spoolman-form label:first-child) {
  margin-top: 0;
}
.panel :deep(.spoolman-form input) {
  width: 100%;
  min-height: 2.75rem;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-text-muted);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text);
  font: inherit;
}
.panel :deep(.spoolman-form input:focus-visible),
.panel :deep(.spoolman-form button:focus-visible) {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.panel :deep(.spoolman-form p) {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}
.panel :deep(.spoolman-form p[role='status']) {
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-inline-start: var(--space-1) solid var(--printer-paused);
  border-radius: var(--radius-sm);
  color: var(--color-text);
}
.panel :deep(.spoolman-form button) {
  justify-self: start;
  margin-top: var(--space-2);
  min-height: 2.75rem;
  padding: var(--space-2) var(--space-4);
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-sm);
  background: var(--color-accent);
  color: var(--color-on-accent);
  font: inherit;
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
}
.panel :deep(.spoolman-form button:disabled) {
  opacity: 0.6;
  cursor: not-allowed;
}

/* SpoolmanResults: result list and saved-settings table. */
.results :deep(.spoolman-results) {
  display: grid;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}
.results :deep(.spoolman-results li) {
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  overflow-wrap: anywhere;
}
.results :deep([data-status]) {
  font-weight: var(--font-weight-semibold);
}
.results :deep([data-status='reachable']) {
  color: var(--printer-idle);
}
.results :deep([data-status='unreachable']),
.results :deep([data-status='failed']) {
  color: var(--printer-error);
}
.results :deep([data-status='unauthorized']) {
  color: var(--printer-paused);
}
.results :deep(table) {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--font-size-sm);
}
.results :deep(th),
.results :deep(td) {
  padding: var(--space-2);
  border-bottom: 1px solid var(--color-border);
  text-align: start;
  vertical-align: top;
}
.results :deep(td:first-child) {
  white-space: nowrap;
}
.results :deep(td:nth-child(2)) {
  min-width: 8rem;
  overflow-wrap: anywhere;
}
.results :deep(th) {
  color: var(--color-text-muted);
  font-weight: var(--font-weight-semibold);
}
.results :deep(tbody tr:last-child td) {
  border-bottom: 0;
}
@media (min-width: 64rem) {
  .layout {
    grid-template-columns: minmax(20rem, 2fr) minmax(0, 3fr);
  }
}
@media (max-width: 30rem) {
  .panel,
  .results > :deep(section) {
    padding: var(--space-3);
  }
  .results :deep(table) {
    font-size: 0.75rem;
  }
  .results :deep(th),
  .results :deep(td) {
    padding-inline: var(--space-1);
  }
  .results :deep(td:nth-child(2)) {
    min-width: 5rem;
  }
}
</style>
