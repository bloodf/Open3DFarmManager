<script setup lang="ts">
import { resolveFarmScope } from '../utils/farm-scope.ts'
import { fetchFarmMemberships } from '../composables/useFarmMemberships.ts'
import { formatWeight } from '../utils/ui-format.ts'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import Button from '../components/ui/Button.vue'
import Card from '../components/ui/Card.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import ErrorState from '../components/ui/ErrorState.vue'
import Field from '../components/ui/Field.vue'
import PageHeader from '../components/ui/PageHeader.vue'
import Skeleton from '../components/ui/Skeleton.vue'
import StaleNotice from '../components/ui/StaleNotice.vue'
import LibraryDetail from '../components/library/LibraryDetail.vue'
import LibraryMetadata from '../components/library/LibraryMetadata.vue'
import LibraryStorage from '../components/library/LibraryStorage.vue'
import LibraryUpload from '../components/library/LibraryUpload.vue'
import {
  compatibleWith,
  emptyFilters,
  filterQuery,
  formatDuration,
  materials,
  nozzleError,
  totalGrams,
  type LibraryFilters,
  type LibraryItem,
  type LibraryLocation,
  type PrinterProfile,
  type StorageMode,
} from '../utils/library-view.ts'
import { useReplayLive } from '../composables/useReplayLive.ts'
import {
  libraryReplayPrinters,
  type LibraryReplayAssignment,
} from '../utils/library-replay.ts'

definePageMeta({
  key: (route) => JSON.stringify([route.path, { farm: route.query.farm }]),
})

type Settings = {
  storageMode: StorageMode
  quotaBytes: number
  retentionDays: number
}

const route = (() => {
  try {
    return (
      useRoute() ?? {
        // The standalone browser harness mounts pages without a Vue Router.
        query: Object.fromEntries(new URLSearchParams(window.location.search)),
      }
    )
  } catch {
    // The standalone browser harness mounts pages without a Vue Router.
    return {
      query: Object.fromEntries(new URLSearchParams(window.location.search)),
    }
  }
})()
const farmId = ref('')
const items = ref<LibraryItem[]>([])
const nextCursor = ref<string | null>(null)
const settings = ref<Settings | null>(null)
const locations = ref<LibraryLocation[]>([])
const usedBytes = ref<number>()
const canManage = ref(false)
const connectors = ref<{ agentId: string }[]>([])
const profiles = ref<PrinterProfile[]>([])
const assignments = ref<LibraryReplayAssignment[]>([])
const live = useReplayLive(farmId)
const replayPrinters = computed(() =>
  libraryReplayPrinters(assignments.value, profiles.value, live.liveFor),
)
const view = ref<'grid' | 'list'>('grid')
const filters = ref<LibraryFilters>({ ...emptyFilters })
const compatPrinter = ref('')
const loading = ref(true)
const loadingMore = ref(false)
const error = ref('')
const modeError = ref('')
const noFarm = ref(false)
const hasMemberships = ref(false)
const status = ref('')
const detailOpen = ref(false)
const detailItem = ref<LibraryItem | null>(null)
const showUpload = ref(false)
let controller: AbortController | undefined
// A failed load moves focus to the alert so it is announced and reachable.
const errorSummary = ref<HTMLElement | null>(null)
watch(
  () => !!error.value && !items.value.length && !loading.value,
  async (failed) => {
    if (!failed) return
    await nextTick()
    errorSummary.value?.focus()
  },
)

const nozzleProblem = computed(() => nozzleError(filters.value.nozzle))
const visible = computed(() =>
  compatibleWith(
    items.value,
    profiles.value.find((p) => p.assignmentId === compatPrinter.value),
  ),
)
const filtered = computed(
  () =>
    Object.values(filters.value).some((v) => v.trim()) || !!compatPrinter.value,
)
const printerLabel = (p: PrinterProfile) =>
  `${p.effective.values.model ?? 'Modelo não informado'} (${p.assignmentId.slice(0, 8)})`
const thumbnail = (item: LibraryItem) =>
  `/api/farms/${farmId.value}/library/versions/${item.latest.id}/thumbnail`

async function search(more = false) {
  if (!farmId.value || nozzleProblem.value) return
  controller?.abort()
  const signal = (controller = new AbortController()).signal
  error.value = ''
  if (more) loadingMore.value = true
  else loading.value = true
  try {
    const query = filterQuery(
      {
        ...filters.value,
        nozzle: filters.value.nozzle.replace(',', '.'),
      },
      more ? (nextCursor.value ?? undefined) : undefined,
    )
    const page = await $fetch<{
      items: LibraryItem[]
      nextCursor: string | null
    }>(`/api/farms/${farmId.value}/library`, {
      query,
      retry: 0,
      timeout: 15_000,
      signal,
    })
    items.value = more ? [...items.value, ...page.items] : page.items
    nextCursor.value = page.nextCursor
  } catch {
    if (signal.aborted) return
    // Fixed copy only: server messages never reach the user.
    error.value = 'Não foi possível carregar a biblioteca. Tente novamente.'
  } finally {
    loading.value = false
    loadingMore.value = false
  }
}

async function loadSettings() {
  const body = await $fetch<{
    settings: Settings
    locations: LibraryLocation[]
    usage?: { usedBytes?: number }
    canManage: boolean
  }>(`/api/farms/${farmId.value}/library/settings`, {
    retry: 0,
    timeout: 15_000,
  })
  settings.value = body.settings
  locations.value = body.locations
  usedBytes.value = body.usage?.usedBytes
  canManage.value = body.canManage
}

async function start() {
  loading.value = true
  error.value = ''
  noFarm.value = false
  try {
    const memberships = await fetchFarmMemberships({ timeout: 15_000 })
    hasMemberships.value = memberships.length > 0
    farmId.value = resolveFarmScope(memberships, route.query.farm)?.farmId ?? ''
    if (!farmId.value) {
      noFarm.value = true
      loading.value = false
      return
    }
    await loadSettings()
    // Side lists are optional: the page works without them.
    const [inventory, printers, farmPrinters] = await Promise.allSettled([
      $fetch<{ connectors: { agentId: string; status: string }[] }>(
        `/api/farms/${farmId.value}/connectors`,
        { retry: 0, timeout: 15_000 },
      ),
      $fetch<{ profiles: PrinterProfile[] }>(
        `/api/farms/${farmId.value}/printer-profiles`,
        { query: { limit: 50 }, retry: 0, timeout: 15_000 },
      ),
      $fetch<{ printers: LibraryReplayAssignment[] }>(
        `/api/farms/${farmId.value}/printers`,
        { query: { limit: 50 }, retry: 0, timeout: 15_000 },
      ),
    ])
    if (inventory.status === 'fulfilled')
      connectors.value = inventory.value.connectors.filter(
        (c) => c.status === 'approved',
      )
    if (printers.status === 'fulfilled')
      profiles.value = printers.value.profiles
    if (farmPrinters.status === 'fulfilled')
      assignments.value = farmPrinters.value.printers
    await search()
  } catch {
    error.value =
      'Não foi possível carregar a biblioteca. Entre na sua conta e tente novamente.'
    loading.value = false
  }
}

async function changeMode(storageMode: StorageMode) {
  status.value = ''
  modeError.value = ''
  try {
    await $fetch(`/api/farms/${farmId.value}/library/settings`, {
      method: 'PUT',
      body: { storageMode },
      retry: 0,
      timeout: 15_000,
    })
    await loadSettings()
    status.value =
      'Modo de armazenamento alterado. Vale para os próximos envios.'
  } catch {
    modeError.value = 'Não foi possível alterar o modo de armazenamento.'
  }
}

async function refreshAll() {
  await Promise.all([search(), loadSettings().catch(() => undefined)])
}
function clearFilters() {
  filters.value = { ...emptyFilters }
  compatPrinter.value = ''
  void search()
}
function openItem(item: LibraryItem) {
  detailItem.value = item
  detailOpen.value = true
}

onMounted(start)
onBeforeUnmount(() => controller?.abort())
</script>

<template>
  <main id="conteudo" class="library ops-screen">
    <div class="ops-heading">
      <p class="ops-wordmark" translate="no">Open3DFarmManager</p>
      <PageHeader
        title="Biblioteca"
        description="Arquivos .gcode e .3mf da farm, com versões e dados lidos do próprio arquivo."
      />
    </div>
    <p v-if="status" role="status" class="notice">{{ status }}</p>

    <p v-if="modeError" role="alert" class="notice error">{{ modeError }}</p>

    <EmptyState
      v-if="noFarm"
      :title="hasMemberships ? 'Selecione uma farm' : 'Nenhuma farm disponível'"
      :description="
        hasMemberships
          ? 'Escolha uma farm para continuar.'
          : 'Crie uma farm ou solicite acesso à pessoa responsável.'
      "
    >
      <NuxtLink to="/farm">Ir para farms</NuxtLink>
    </EmptyState>
    <div
      v-else-if="error && !items.length && !loading"
      ref="errorSummary"
      role="alert"
      tabindex="-1"
    >
      <ErrorState title="Biblioteca indisponível" :description="error">
        <div class="actions">
          <Button @click="farmId ? search() : start()">Tentar novamente</Button>
          <NuxtLink to="/entrar">Entrar na conta</NuxtLink>
        </div>
      </ErrorState>
    </div>

    <template v-if="farmId">
      <form
        class="filters ops-panel"
        role="search"
        aria-labelledby="library-filters-title"
        :aria-busy="loading"
        novalidate
        @submit.prevent="search()"
      >
        <h2 id="library-filters-title" class="ops-title">Filtros</h2>
        <div class="filter-grid">
          <Field label="Título">
            <template #default="{ control }">
              <input v-bind="control" v-model="filters.title" type="search" />
            </template>
          </Field>
          <Field label="Modelo da impressora">
            <template #default="{ control }">
              <input
                v-bind="control"
                v-model="filters.printerModel"
                type="text"
              />
            </template>
          </Field>
          <Field label="Bico (mm)" :error="nozzleProblem">
            <template #default="{ control }">
              <input
                v-bind="control"
                v-model="filters.nozzle"
                type="text"
                inputmode="decimal"
              />
            </template>
          </Field>
          <Field label="Material">
            <template #default="{ control }">
              <input v-bind="control" v-model="filters.material" type="text" />
            </template>
          </Field>
          <Field label="Etiqueta">
            <template #default="{ control }">
              <input v-bind="control" v-model="filters.tag" type="text" />
            </template>
          </Field>
          <Field
            label="Compatível com"
            hint="Oculta o que o perfil da impressora bloqueia."
          >
            <template #default="{ control }">
              <select v-bind="control" v-model="compatPrinter">
                <option value="">Qualquer impressora</option>
                <option
                  v-for="p in profiles"
                  :key="p.assignmentId"
                  :value="p.assignmentId"
                >
                  {{ printerLabel(p) }}
                </option>
              </select>
            </template>
          </Field>
        </div>
        <div class="actions">
          <Button type="submit" class="ops-primary">Buscar</Button>
          <Button v-if="filtered" @click="clearFilters">Limpar filtros</Button>
        </div>
      </form>

      <div class="toolbar">
        <div class="segmented" role="group" aria-label="Modo de exibição">
          <Button :aria-pressed="view === 'grid'" @click="view = 'grid'"
            >Grade</Button
          >
          <Button :aria-pressed="view === 'list'" @click="view = 'list'"
            >Lista</Button
          >
        </div>
        <Button
          :aria-expanded="showUpload"
          aria-controls="library-upload"
          @click="showUpload = !showUpload"
        >
          Enviar arquivo
        </Button>
      </div>

      <section
        v-if="showUpload && settings"
        id="library-upload"
        class="ops-panel"
        aria-labelledby="library-upload-title"
      >
        <h2 id="library-upload-title" class="ops-title">Enviar arquivo</h2>
        <LibraryUpload
          :farm-id="farmId"
          :mode="settings.storageMode"
          :connectors="connectors"
          @uploaded="refreshAll"
        />
      </section>

      <p role="status" class="count">
        <template v-if="!loading"
          >{{ visible.length }} item(ns) na lista.</template
        >
      </p>
      <StaleNotice
        v-if="error && items.length && !loading"
        role="alert"
        title="Lista desatualizada"
        description="Não foi possível atualizar a biblioteca. Mostrando a última lista carregada, que pode não refletir os filtros atuais."
      >
        <Button @click="search()">Tentar novamente</Button>
      </StaleNotice>

      <div v-if="loading" aria-busy="true" class="loading ops-panel">
        <p role="status">Carregando a biblioteca…</p>
        <Skeleton /><Skeleton /><Skeleton />
      </div>
      <EmptyState
        v-else-if="!visible.length"
        :title="filtered ? 'Nenhum item encontrado' : 'A biblioteca está vazia'"
        :description="
          filtered
            ? 'Nenhum arquivo combina com os filtros. Ajuste ou limpe os filtros.'
            : 'Envie um arquivo .gcode ou .3mf para começar.'
        "
      />
      <ul v-else :class="['items', view]" aria-label="Itens da biblioteca">
        <li v-for="item in visible" :key="item.id">
          <Card>
            <article class="item">
              <img
                v-if="item.latest.hasThumbnail"
                :src="thumbnail(item)"
                alt=""
                width="96"
                height="96"
                loading="lazy"
              />
              <div v-else class="no-thumb" aria-hidden="true">3D</div>
              <div class="body">
                <h2>{{ item.title }}</h2>
                <p class="line">
                  {{
                    item.latest.metadata.printerModel ?? 'Modelo não informado'
                  }}
                  ·
                  {{
                    formatDuration(item.latest.metadata.estimatedTimeSeconds)
                  }}
                  <template
                    v-if="totalGrams(item.latest.metadata) !== undefined"
                  >
                    ·
                    {{ formatWeight(totalGrams(item.latest.metadata)) }}
                  </template>
                  ·
                  {{ item.latest.metadata.slicer ?? 'fatiador não informado' }}
                </p>
                <LibraryMetadata
                  v-if="view === 'list'"
                  :metadata="item.latest.metadata"
                />
                <p v-else class="line">
                  {{
                    materials(item.latest.metadata)
                      .map((m) => m.type ?? m.colour)
                      .join(', ') || 'Material não informado'
                  }}
                </p>
                <p v-if="item.tags.length" class="line">
                  Etiquetas: {{ item.tags.join(', ') }}
                </p>
                <Button
                  class="details"
                  :aria-label="`Ver detalhes de ${item.title}`"
                  @click="openItem(item)"
                >
                  Ver detalhes
                </Button>
              </div>
            </article>
          </Card>
        </li>
      </ul>
      <Button
        v-if="nextCursor && !loading"
        :disabled="loadingMore"
        @click="search(true)"
      >
        {{ loadingMore ? 'Carregando…' : 'Carregar mais' }}
      </Button>

      <LibraryStorage
        v-if="settings"
        class="ops-panel"
        :mode="settings.storageMode"
        :quota-bytes="settings.quotaBytes"
        :retention-days="settings.retentionDays"
        :locations="locations"
        :used-bytes="usedBytes"
        :can-manage="canManage"
        @change-mode="changeMode"
      />

      <LibraryDetail
        v-if="settings"
        v-model="detailOpen"
        :farm-id="farmId"
        :item="detailItem"
        :can-manage="canManage"
        :can-upload="true"
        :mode="settings.storageMode"
        :connectors="connectors"
        :replay-printers="replayPrinters"
        :replay-send="live.send"
        @changed="refreshAll"
      />
    </template>
  </main>
</template>

<style scoped>
[role='alert']:focus-visible {
  border-radius: var(--ops-radius-lg);
}
.notice {
  margin: 0;
  max-width: none;
  padding: var(--ops-space-3) var(--ops-space-4);
  border: 1px solid var(--ops-action);
  border-radius: var(--ops-radius-lg);
  background: var(--ops-panel);
}
.notice.error {
  color: var(--ops-fault);
  background: var(--ops-fault-bg);
  border-color: var(--ops-fault);
}
.filter-grid {
  align-items: start;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr));
  gap: var(--ops-space-3);
}
.filter-grid :deep(.field) {
  grid-template-columns: minmax(0, 1fr);
  min-width: 0;
}
.filter-grid :deep(.field span) {
  color: var(--ops-muted);
  font-size: var(--ops-text-small);
  line-height: 16px;
}
.filter-grid :deep(.field span.error) {
  color: var(--ops-fault);
}
.actions,
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ops-space-2) var(--ops-space-4);
  align-items: center;
}
.toolbar {
  justify-content: space-between;
}
/* Exclusive view modes read as one segmented control. */
.segmented {
  display: flex;
  flex-wrap: wrap;
}
.segmented :deep(button.ui-button) {
  min-width: 5rem;
  border-radius: 0;
}
.segmented :deep(button.ui-button:first-child) {
  border-start-start-radius: var(--ops-radius-md);
  border-end-start-radius: var(--ops-radius-md);
}
.segmented :deep(button.ui-button:last-child) {
  margin-inline-start: -1px;
  border-start-end-radius: var(--ops-radius-md);
  border-end-end-radius: var(--ops-radius-md);
}
.segmented :deep(button.ui-button[aria-pressed='true']) {
  color: var(--ops-on-action);
  background: var(--ops-action);
  border-color: var(--ops-action);
}
.segmented :deep(button.ui-button:focus-visible) {
  position: relative;
}
.count {
  margin: 0;
  color: var(--ops-muted);
  font: var(--ops-text-small) / 16px var(--ops-font-mono);
  font-variant-numeric: tabular-nums;
}
.count:empty {
  display: none;
}
.items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: var(--ops-space-3);
}
.items.grid {
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 15rem), 1fr));
}
.items li {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  min-width: 0;
}
.items :deep(.ui-card) {
  overflow: hidden;
  padding: 0;
}
.item {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ops-space-3);
  block-size: 100%;
  padding: var(--ops-space-3);
}
.grid .item {
  flex-direction: column;
  flex-wrap: nowrap;
  padding: 0;
}
.body {
  display: flex;
  flex: 1 1 14rem;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--ops-space-2);
  min-width: 0;
}
.grid .body {
  flex: 1 0 auto;
  padding: var(--ops-space-3);
}
.body > :deep(.meta) {
  align-self: stretch;
}
.item h2 {
  margin: 0;
  font-size: var(--ops-text-body);
  line-height: 20px;
  overflow-wrap: anywhere;
}
img,
.no-thumb {
  flex: none;
  inline-size: 6rem;
  block-size: 6rem;
  object-fit: contain;
  border-radius: var(--ops-radius-md);
  background: var(--ops-raised);
}
.grid img,
.grid .no-thumb {
  inline-size: 100%;
  block-size: 8rem;
  border-radius: 0;
  border-block-end: 1px solid var(--ops-border);
}
.no-thumb {
  display: grid;
  place-items: center;
  color: var(--ops-muted);
  font: 600 var(--ops-text-title) var(--ops-font-mono);
}
.line {
  margin: 0;
  color: var(--ops-muted);
  font-size: var(--ops-text-small);
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.details {
  margin-block-start: auto;
}
.loading p {
  margin: 0;
}
.library :deep(.stale strong) {
  display: block;
}
/* The version history needs more room than the kit's default dialog. */
.library :deep(dialog[aria-labelledby]) {
  inline-size: min(56rem, calc(100% - 2 * var(--ops-space-4)));
  max-inline-size: min(56rem, calc(100% - 2 * var(--ops-space-4)));
}
</style>
