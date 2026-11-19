<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
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
const live = useReplayLive()
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
  <main class="library">
    <h1>Biblioteca</h1>
    <p>
      Arquivos .gcode e .3mf da farm, com versões e dados lidos do próprio
      arquivo.
    </p>
    <p v-if="status" role="status">{{ status }}</p>

    <p v-if="modeError" role="alert" class="error">{{ modeError }}</p>

    <EmptyState
      v-if="noFarm"
      title="Nenhuma farm disponível"
      description="Esta conta ainda não tem uma farm. Crie uma farm ou peça acesso para usar a biblioteca."
    >
      <NuxtLink to="/farm">Ir para farms</NuxtLink>
    </EmptyState>
    <div v-else-if="error && !items.length && !loading" role="alert">
      <ErrorState title="Biblioteca indisponível" :description="error">
        <Button @click="farmId ? search() : start()">Tentar novamente</Button>
      </ErrorState>
    </div>

    <template v-if="farmId">
      <form
        class="filters"
        role="search"
        aria-label="Filtros da biblioteca"
        novalidate
        @submit.prevent="search()"
      >
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
        aria-labelledby="library-upload-title"
      >
        <h2 id="library-upload-title">Enviar arquivo</h2>
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

      <div v-if="loading" aria-busy="true" class="loading">
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
                    {{
                      String(totalGrams(item.latest.metadata)).replace('.', ',')
                    }}
                    g
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
.filters {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
  gap: var(--space-3);
  margin-block-end: var(--space-4);
}
.actions,
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: end;
}
.toolbar {
  justify-content: space-between;
  margin-block-end: var(--space-3);
}
.items {
  list-style: none;
  margin: 0 0 var(--space-4);
  padding: 0;
  display: grid;
  gap: var(--space-3);
}
.items.grid {
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 16rem), 1fr));
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
  font-size: 1.125rem;
  margin: 0 0 var(--space-2);
  overflow-wrap: anywhere;
}
img,
.no-thumb {
  inline-size: 6rem;
  block-size: 6rem;
  object-fit: contain;
  border-radius: var(--radius-sm);
  background: var(--surface);
}
.no-thumb {
  display: grid;
  place-items: center;
  color: var(--text-muted);
}
.line {
  margin: 0 0 var(--space-2);
  overflow-wrap: anywhere;
}
.error {
  color: var(--printer-error);
}
.loading {
  display: grid;
  gap: var(--space-3);
}
</style>
