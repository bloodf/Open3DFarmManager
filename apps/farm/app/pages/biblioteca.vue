<script setup lang="ts">
import { formatWeight } from '../utils/ui-format.ts'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Button from '../components/ui/Button.vue'
import Card from '../components/ui/Card.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import ErrorState from '../components/ui/ErrorState.vue'
import Field from '../components/ui/Field.vue'
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

type Settings = {
  storageMode: StorageMode
  quotaBytes: number
  retentionDays: number
}

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
    const page = await $fetch<{ farms: { farmId: string }[] }>('/api/farms', {
      query: { limit: 1 },
      retry: 0,
      timeout: 15_000,
    })
    farmId.value = page.farms[0]?.farmId ?? ''
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
  <main id="conteudo" class="library">
    <header class="page-header">
      <p class="eyebrow">Open3DFarmManager</p>
      <h1>Biblioteca</h1>
      <p class="intro">
        Arquivos .gcode e .3mf da farm, com versões e dados lidos do próprio
        arquivo.
      </p>
    </header>
    <p v-if="status" role="status" class="notice">{{ status }}</p>

    <p v-if="modeError" role="alert" class="notice error">{{ modeError }}</p>

    <EmptyState
      v-if="noFarm"
      title="Nenhuma farm disponível"
      description="Esta conta ainda não tem uma farm. Crie uma farm ou peça acesso para usar a biblioteca."
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
        class="filters panel"
        role="search"
        aria-labelledby="library-filters-title"
        :aria-busy="loading"
        novalidate
        @submit.prevent="search()"
      >
        <h2 id="library-filters-title" class="panel-title">Filtros</h2>
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
          <Button type="submit">Buscar</Button>
          <Button v-if="filtered" @click="clearFilters">Limpar filtros</Button>
        </div>
      </form>

      <div class="toolbar">
        <div role="group" aria-label="Modo de exibição">
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
        class="panel"
        aria-labelledby="library-upload-title"
      >
        <h2 id="library-upload-title" class="panel-title">Enviar arquivo</h2>
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

      <div v-if="loading" aria-busy="true" class="loading panel">
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
.library {
  display: grid;
  gap: var(--space-4);
  align-content: start;
}
.library > * {
  min-width: 0;
}
[role='alert']:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
  border-radius: var(--radius-md);
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
.panel {
  margin: 0;
  padding: var(--space-5);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  min-width: 0;
}
.panel-title {
  margin: 0 0 var(--space-3);
}
.notice {
  margin: 0;
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
}
.notice.error {
  border-color: var(--state-error-color);
}
.filters {
  display: grid;
  gap: var(--space-4);
}
.filter-grid {
  align-items: start;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr));
  gap: var(--space-3) var(--space-4);
}
.actions,
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
  align-items: center;
}
.toolbar {
  justify-content: space-between;
}
.toolbar [role='group'] {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.toolbar [aria-pressed='true'] {
  color: var(--color-on-accent);
  background: var(--color-accent);
}
.count {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}
.count:empty {
  display: none;
}
.items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: var(--space-3);
}
.items.grid {
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 16rem), 1fr));
}
.items li {
  min-width: 0;
}
.item {
  display: flex;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.grid .item {
  flex-direction: column;
}
.body {
  flex: 1 1 14rem;
  min-width: 0;
}
h2 {
  font-size: var(--font-size-lg);
  line-height: var(--line-height-tight);
  margin: 0 0 var(--space-2);
  overflow-wrap: anywhere;
}
img,
.no-thumb {
  inline-size: 6rem;
  block-size: 6rem;
  object-fit: contain;
  border-radius: var(--radius-sm);
  background: var(--color-surface);
}
.no-thumb {
  display: grid;
  place-items: center;
  color: var(--color-text-muted);
}
.line {
  margin: 0 0 var(--space-2);
  overflow-wrap: anywhere;
}
.loading {
  display: grid;
  gap: var(--space-3);
}
.loading p {
  margin: 0;
}
input,
select {
  inline-size: 100%;
  min-height: 2.75rem;
  min-width: 0;
  padding: var(--space-2) var(--space-3);
  font: inherit;
  color: inherit;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}
:is(input, select):focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
/* Child forms (upload, storage) share the page's control look. */
.library :deep(.stale strong) {
  display: block;
}
.library :deep(select),
.library :deep(textarea),
.library :deep(input:not([type='file'], [type='checkbox'], [type='radio'])) {
  min-height: 2.75rem;
  max-inline-size: 100%;
  padding: var(--space-2) var(--space-3);
  font: inherit;
  color: inherit;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}
.library :deep(#library-storage ~ * select),
.library :deep(section[aria-labelledby='library-storage'] select) {
  margin-inline: var(--space-2);
}
.library :deep(:is(select, textarea, input):focus-visible) {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
/* Same bordered surface as the panels. */
.library :deep(.ui-card) {
  border: 1px solid var(--color-border);
  box-shadow: none;
}
@media (max-width: 30rem) {
  .panel {
    padding: var(--space-4);
  }
}
</style>
