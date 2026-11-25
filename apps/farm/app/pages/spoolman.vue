<script setup lang="ts">
import '../assets/css/ops-screen.css'
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
const serviceId = ref('')
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
    serviceId: serviceId.value,
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
  <main class="spoolman-page ops-screen">
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
          v-model:service-id="serviceId"
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
.loading :deep(.skeleton) {
  min-block-size: var(--ops-space-5);
}
.layout {
  display: grid;
  gap: var(--ops-space-4);
  align-items: start;
  min-width: 0;
}
.results {
  display: grid;
  gap: var(--ops-space-4);
  min-width: 0;
}
.notice,
.spoolman-error {
  padding: var(--ops-space-2) var(--ops-space-3);
  border: 1px solid var(--ops-border);
  border-inline-start: 3px solid var(--ops-action);
  border-radius: var(--ops-radius-sm);
  background: var(--ops-panel);
}
.spoolman-error {
  border-inline-start-color: var(--ops-fault);
  overflow-wrap: anywhere;
}
.spoolman-error:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
/* The error card already sits inside the alert box: no second frame. */
.spoolman-error :deep(.ui-card.ui-card) {
  padding: 0;
  border: 0;
  background: transparent;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ops-space-2);
  align-items: center;
}

/* SpoolmanForm: stacked, labelled, touch-sized controls. */
.panel :deep(.spoolman-form) {
  display: grid;
  gap: var(--ops-space-1);
}
.panel :deep(.spoolman-form label:not(:first-child)) {
  margin-top: var(--ops-space-3);
}
.panel :deep(.spoolman-form input) {
  width: 100%;
}
.panel :deep(.spoolman-form p) {
  font-size: var(--ops-text-small);
  line-height: 18px;
  color: var(--ops-muted);
}
.panel :deep(.spoolman-form .service-id-error) {
  color: var(--ops-fault);
  font-weight: 600;
}
.panel :deep(.spoolman-form p[role='status']) {
  padding: var(--ops-space-2) var(--ops-space-3);
  border: 1px solid var(--ops-attention);
  border-radius: var(--ops-radius-sm);
  background: var(--ops-attention-bg);
  color: var(--ops-attention);
}
.panel :deep(.spoolman-form button) {
  justify-self: start;
  margin-top: var(--ops-space-3);
}

/* SpoolmanResults: result list and saved-settings table. */
.results :deep(.spoolman-results) {
  display: grid;
  gap: var(--ops-space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}
.results :deep(.spoolman-results li) {
  padding: var(--ops-space-2) var(--ops-space-3);
  border: 1px solid var(--ops-border);
  border-radius: var(--ops-radius-sm);
  overflow-wrap: anywhere;
}
.results :deep([data-status]) {
  display: inline-block;
  padding: 1px var(--ops-space-2);
  border: 1px solid currentColor;
  border-radius: var(--ops-radius-sm);
  font-size: var(--ops-text-small);
  font-weight: 600;
  line-height: 18px;
}
.results :deep(li [data-status]) {
  margin-inline: var(--ops-space-1);
}
.results :deep([data-status='reachable']) {
  color: var(--ops-action);
  background: var(--ops-idle-bg);
}
.results :deep([data-status='unreachable']),
.results :deep([data-status='failed']) {
  color: var(--ops-fault);
  background: var(--ops-fault-bg);
}
.results :deep([data-status='unauthorized']),
.results :deep([data-status='unapplied']) {
  color: var(--ops-attention);
  background: var(--ops-attention-bg);
}
.results :deep(table) {
  width: 100%;
  border-collapse: collapse;
}
.results :deep(th),
.results :deep(td) {
  text-align: start;
  vertical-align: top;
}
.results :deep(td:first-child),
.results :deep(td:nth-child(2)),
.results :deep(td:nth-child(3)),
.results :deep(td:last-child) {
  font-family: var(--ops-font-mono);
  font-size: var(--ops-text-small);
  font-variant-numeric: tabular-nums;
}
.results :deep(td:first-child) {
  white-space: nowrap;
}
.results :deep(td:nth-child(2)) {
  min-width: 8rem;
  overflow-wrap: anywhere;
}
.results :deep(tbody tr:last-child td) {
  border-bottom: 0;
}
@media (min-width: 64rem) {
  .layout {
    grid-template-columns: minmax(20rem, 24rem) minmax(0, 1fr);
  }
}
@media (max-width: 30rem) {
  .results :deep(th),
  .results :deep(td) {
    padding-inline: var(--ops-space-1);
  }
  .results :deep(td:nth-child(2)) {
    min-width: 5rem;
  }
}
</style>
