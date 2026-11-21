<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import FarmMap from '../components/network/FarmMap.vue'
import FarmScopeSelector from '../components/farm/FarmScopeSelector.vue'
import SettingsPage from '../components/settings/SettingsPage.vue'
import SettingsPanel from '../components/settings/SettingsPanel.vue'
import Button from '../components/ui/Button.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import ErrorState from '../components/ui/ErrorState.vue'
import Skeleton from '../components/ui/Skeleton.vue'
import StaleNotice from '../components/ui/StaleNotice.vue'
import { farmViewErrorText } from '../utils/farm-view-error.ts'
import { useFarmView } from '../composables/useFarmView.ts'
import {
  buildEntries,
  connectorName,
  printerOverlayKey,
  type NetworkData,
} from '../utils/network-map.ts'

import { createPrinterSetup } from '../utils/printer-setup.ts'
import {
  createPrinterSetupState,
  type DiscoveredPrinter,
} from '../utils/printer-setup-state.ts'
import { openPrinterDiscoverySession } from '../utils/printer-discovery-view-session.ts'
import { mergeNetworkDiscoveries } from '../utils/network-adoption.ts'
import type { NetworkDiscovered } from '../utils/network-map.ts'

const REFRESH_MS = 30_000
const view = useFarmView()
const { state, ready, now, discover, selectFarm } = view

const data = ref<NetworkData | null>(null)
const readAt = ref<number | null>(null)
const failure = ref('')
const loading = ref(false)
let controller: AbortController | undefined
let timer: ReturnType<typeof setInterval> | undefined

const farmId = computed(() => ready.value?.scope?.farmId ?? '')

const adoption = useNetworkAdoption()
const router = useRouter()
const approved = computed(() =>
  data.value?.canManage
    ? data.value.connectors.filter(
        (connector) => connector.status === 'approved',
      )
    : [],
)
const managedAgents = computed(
  () => new Set(approved.value.map((connector) => connector.agentId)),
)
const scanAgent = ref('')
const selectedScanAgent = computed(() =>
  managedAgents.value.has(scanAgent.value)
    ? scanAgent.value
    : approved.value[0]?.agentId,
)
const scanned = ref<NetworkDiscovered[]>([])
const scanning = ref(false)
const scanMessage = ref('')
let cancelScan: (() => void) | undefined

function resetScan() {
  cancelScan?.()
  cancelScan = undefined
  scanned.value = []
  scanAgent.value = ''
  scanning.value = false
  scanMessage.value = ''
}

async function scan() {
  const agentId = selectedScanAgent.value
  if (scanning.value || !agentId || !managedAgents.value.has(agentId)) return
  const setupState = createPrinterSetupState()
  let scanGeneration = 0
  let scanController: AbortController | undefined
  const setup = createPrinterSetup(
    setupState,
    {
      generation: () => scanGeneration,
      next: () => ++scanGeneration,
      controller: () => scanController,
      setController: (controller) => (scanController = controller),
    },
    {
      openPrinterDiscoverySession,
      async handleKobraException() {},
    },
  )
  const cancel = setup.clear
  cancelScan = cancel
  setupState.farmId.value = farmId.value
  setupState.canManage.value = true
  setupState.kobraAgentId.value = agentId
  scanning.value = true
  scanMessage.value = 'Procurando impressoras…'
  try {
    await setup.refreshKobraContext(false)
    if (cancelScan !== cancel) return
    await setup.searchPrinters()
    if (cancelScan !== cancel) return
    const foundAt = Date.now()
    scanned.value = mergeNetworkDiscoveries(
      scanned.value,
      setupState.discoveryPrinters.value.map((printer) => ({
        ...printer,
        agentId,
        adopted: false,
        lastSeen: foundAt,
      })),
    )
    scanMessage.value =
      setupState.discoveryMessage.value ||
      'Verifique se este navegador está aprovado e se o Connector está disponível.'
  } catch {
    if (cancelScan === cancel)
      scanMessage.value =
        'Não foi possível procurar impressoras. Tente novamente.'
  } finally {
    cancel()
    if (cancelScan === cancel) {
      cancelScan = undefined
      scanning.value = false
    }
  }
}

async function adopt(agentId: string, printer: DiscoveredPrinter) {
  if (!farmId.value || !managedAgents.value.has(agentId)) return
  if (adoption.value) return
  const target = { farmId: farmId.value, agentId, printer }
  adoption.value = target
  try {
    if (await router.push('/impressoras')) adoption.value = null
  } catch {
    adoption.value = null
    scanMessage.value = 'Não foi possível abrir a configuração da impressora.'
  }
}

async function load() {
  const id = farmId.value
  controller?.abort()
  if (!id) {
    data.value = null
    return
  }
  controller = new AbortController()
  const { signal } = controller
  loading.value = true
  // A retry with nothing to show starts clean; kept data keeps its notice.
  if (!data.value) failure.value = ''
  try {
    const result = await $fetch<NetworkData>(
      `/api/farms/${encodeURIComponent(id)}/network`,
      { signal, retry: 0, timeout: 10_000, cache: 'no-store' },
    )
    if (signal.aborted) return
    if (!result.canManage) resetScan()
    else {
      const active = new Set(
        result.connectors
          .filter((item) => item.status === 'approved')
          .map((item) => item.agentId),
      )
      scanned.value = scanned.value.filter((item) => active.has(item.agentId))
      if (
        scanning.value &&
        selectedScanAgent.value &&
        !active.has(selectedScanAgent.value)
      ) {
        cancelScan?.()
        cancelScan = undefined
        scanning.value = false
        scanMessage.value = 'O Connector da busca está indisponível.'
      }
    }
    data.value = result
    readAt.value = Date.now()
    failure.value = ''
  } catch (error) {
    if (signal.aborted) return
    const status = (error as { status?: number }).status
    if (status === 401 || status === 404) {
      resetScan()
      data.value = null
    }
    failure.value =
      status === 401
        ? 'Entre novamente para consultar a rede.'
        : 'Não foi possível atualizar a rede da farm. Tente novamente.'
  } finally {
    if (!signal.aborted) loading.value = false
  }
}
watch(
  farmId,
  () => {
    resetScan()
    data.value = null
    readAt.value = null
    void load()
  },
  { flush: 'sync' },
)
onMounted(() => {
  if (farmId.value) void load()
  timer = setInterval(() => void load(), REFRESH_MS)
})
onBeforeUnmount(() => {
  resetScan()
  clearInterval(timer)
  controller?.abort()
})

const liveAgents = computed(
  () =>
    new Set(
      (ready.value?.rows ?? [])
        .filter((row) => row.connection === 'authenticated')
        .map((row) => row.assignment.agentId),
    ),
)
const livePrinters = computed(
  () =>
    new Map(
      (ready.value?.rows ?? []).flatMap((row) =>
        row.connection === 'authenticated' &&
        row.observation &&
        !row.observation.historical
          ? [
              [
                printerOverlayKey(
                  row.assignment.agentId,
                  row.assignment.printerKey,
                ),
                {
                  online: row.observation.state.state !== 'offline',
                  at: row.observation.received.wall,
                  ...(row.observation.state.linkHealth
                    ? { link: row.observation.state.linkHealth }
                    : {}),
                },
              ] as const,
            ]
          : [],
      ),
    ),
)
const entries = computed(() =>
  data.value
    ? buildEntries(
        {
          ...data.value,
          discovered: mergeNetworkDiscoveries(
            data.value.discovered,
            scanned.value,
          ),
        },
        {
          agents: liveAgents.value,
          printers: livePrinters.value,
          now: now.value.wall || Date.now(),
        },
      )
    : [],
)
</script>

<template>
  <SettingsPage title="Rede da farm" focus-heading>
    <template #intro>
      Connectors e impressoras da farm, com a saúde do enlace de cada um.
    </template>
    <div v-if="state.kind === 'loading'" class="loading panel" aria-busy="true">
      <p role="status">Carregando suas farms…</p>
      <Skeleton /><Skeleton /><Skeleton />
    </div>
    <section
      v-else-if="state.kind === 'sign-in-required'"
      aria-label="Acesso à farm"
    >
      <EmptyState
        title="Entre para ver a rede"
        description="Entre na sua conta para consultar a rede."
      >
        <NuxtLink to="/entrar">Entrar</NuxtLink>
      </EmptyState>
    </section>
    <ErrorState
      v-else-if="state.kind === 'error'"
      title="Não foi possível carregar suas farms"
    >
      <p role="alert">{{ farmViewErrorText(state.reason) }}</p>
      <div class="actions">
        <Button @click="discover()">Tentar novamente</Button>
        <NuxtLink to="/entrar">Entrar novamente</NuxtLink>
      </div>
    </ErrorState>
    <template v-else-if="ready">
      <FarmScopeSelector
        :ready="ready"
        @select="selectFarm"
        @discover="discover"
      />
      <ErrorState v-if="failure && !data" title="Rede indisponível">
        <p role="alert">{{ failure }}</p>
        <div class="actions">
          <Button @click="load()">Tentar novamente</Button>
        </div>
      </ErrorState>
      <StaleNotice v-else-if="failure" role="alert" :description="failure">
        <Button class="retry" @click="load()">Tentar novamente</Button>
      </StaleNotice>
      <EmptyState
        v-if="!ready.scope"
        :title="
          ready.farms.length
            ? 'Nenhuma farm selecionada'
            : 'Nenhuma farm disponível'
        "
        :description="
          ready.farms.length
            ? 'Selecione uma farm para ver a rede.'
            : 'Peça acesso a quem administra a farm ou entre com outra conta.'
        "
      >
        <NuxtLink v-if="!ready.farms.length" to="/entrar"
          >Entrar com outra conta</NuxtLink
        >
      </EmptyState>
      <div
        v-else-if="loading && !data && !failure"
        class="loading panel"
        aria-busy="true"
      >
        <p role="status">Carregando a rede…</p>
        <Skeleton /><Skeleton /><Skeleton />
      </div>
      <template v-else-if="data">
        <SettingsPanel
          v-if="approved.length"
          heading-id="rede-busca-heading"
          title="Procurar impressoras"
          :busy="scanning"
        >
          <template #description>
            Procure impressoras novas na rede de um Connector aprovado e
            adicione as encontradas à farm.
          </template>
          <div class="scan">
            <div class="field">
              <label for="rede-scan-connector">Connector para a busca</label>
              <select
                id="rede-scan-connector"
                :value="selectedScanAgent"
                :disabled="scanning"
                @change="scanAgent = ($event.target as HTMLSelectElement).value"
              >
                <option
                  v-for="connector in approved"
                  :key="connector.agentId"
                  :value="connector.agentId"
                >
                  {{ connectorName(connector.agentId) }}
                </option>
              </select>
            </div>
            <Button :disabled="scanning" @click="scan()">
              Procurar agora
            </Button>
          </div>
          <p class="scan-status" role="status">{{ scanMessage }}</p>
        </SettingsPanel>
        <FarmMap
          :entries="entries"
          :now="now.wall || Date.now()"
          :live="liveAgents.size > 0"
          :as-of="readAt"
          :managed-agents="managedAgents"
          @adopt="adopt"
        />
      </template>
    </template>
  </SettingsPage>
</template>

<style scoped>
.loading {
  display: grid;
  gap: var(--space-3);
}
.panel {
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
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
  align-items: center;
}
.retry {
  margin-inline-start: var(--space-3);
}
.scan {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3) var(--space-4);
  align-items: end;
}
.field {
  display: grid;
  gap: var(--space-1);
  min-width: min(100%, 14rem);
  flex: 1 1 14rem;
  max-inline-size: 28rem;
}
label {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
}
select {
  inline-size: 100%;
  min-block-size: 2.75rem;
  padding: var(--space-2) var(--space-3);
  font: inherit;
  color: inherit;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}
select:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
select:disabled {
  opacity: 0.6;
}
.scan-status:empty {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
.scan-status {
  margin: 0;
  color: var(--color-text-muted);
}
/* The farm scope selector is a shared component: give its section the same
   panel surface as the others on this screen. */
:deep(#farm-scope-heading) {
  margin: 0 0 var(--space-3);
  font-size: var(--font-size-lg);
  line-height: var(--line-height-tight);
}
:deep(section[aria-labelledby='farm-scope-heading']) {
  margin: 0;
  padding: var(--space-5);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  min-width: 0;
}
:deep(section[aria-labelledby='farm-scope-heading'] .actions:empty) {
  display: none;
}
@media (max-width: 30rem) {
  .panel,
  :deep(section[aria-labelledby='farm-scope-heading']) {
    padding: var(--space-4);
  }
}
</style>
