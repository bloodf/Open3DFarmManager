<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import Button from '../../components/ui/Button.vue'
import EmptyState from '../../components/ui/EmptyState.vue'
import ErrorState from '../../components/ui/ErrorState.vue'
import Meter from '../../components/ui/Meter.vue'
import Skeleton from '../../components/ui/Skeleton.vue'
import StatusBadge from '../../components/ui/StatusBadge.vue'
import ColorSwatch from '../../components/spool-library/ColorSwatch.vue'
import ConfirmDeleteDialog from '../../components/spool-library/ConfirmDeleteDialog.vue'
import SpoolFormDialog from '../../components/spool-library/SpoolFormDialog.vue'
import SpoolLibraryShell from '../../components/spool-library/SpoolLibraryShell.vue'
import SpoolUseMeasureDialog from '../../components/spool-library/SpoolUseMeasureDialog.vue'
import { useSpoolLibraryFarm } from '../../composables/useSpoolLibraryFarm.ts'
import {
  buildSpoolQuery,
  distinctMaterials,
  EMPTY_SPOOL_FILTERS,
  extractApiError,
  formatIsoDate,
  formatPrice,
  formatSpoolLength,
  formatSpoolWeight,
  SPOOL_SORT_OPTIONS,
  spoolBaseWeight,
  spoolDisplayTitle,
  spoolRemainingPercent,
} from '../../utils/spool-library-format.ts'
import type {
  FilamentItem,
  SpoolFilters,
  SpoolItem,
  SpoolLibraryItemResponse,
  SpoolLibraryListResponse,
  VendorItem,
} from '../../utils/spool-library-types.ts'

const {
  farms,
  farmId,
  loadingFarm,
  farmLoadError,
  signInRequired,
  noFarm,
  loadFarms,
  selectFarm,
} = useSpoolLibraryFarm()

const spools = ref<SpoolItem[]>([])
const total = ref(0)
const filaments = ref<FilamentItem[]>([])
const vendors = ref<VendorItem[]>([])
const canWrite = ref(false)
const canImport = ref(false)
const loadingList = ref(false)
const listError = ref('')
const statusMessage = ref('')

const filters = reactive<SpoolFilters>({ ...EMPTY_SPOOL_FILTERS })

const formOpen = ref(false)
const editingSpool = ref<SpoolItem | null>(null)
const formBusy = ref(false)
const formError = ref('')

const actionOpen = ref(false)
const actionMode = ref<'use' | 'measure'>('use')
const actionSpool = ref<SpoolItem | null>(null)
const actionBusy = ref(false)
const actionError = ref('')

const deleteOpen = ref(false)
const deletingSpool = ref<SpoolItem | null>(null)
const deleteBusy = ref(false)
const deleteError = ref('')

const archivingId = ref<number | null>(null)

let listController: AbortController | undefined

const availableMaterials = computed(() =>
  distinctMaterials(filaments.value.length ? filaments.value : spools.value),
)

const hasActiveFilters = computed(() =>
  Boolean(
    filters.q.trim() ||
    filters.material.trim() ||
    filters.vendorId.trim() ||
    filters.location.trim() ||
    filters.allowArchived,
  ),
)

async function loadCatalogOptions() {
  if (!farmId.value) return
  const [filRes, venRes] = await Promise.allSettled([
    $fetch<SpoolLibraryListResponse<FilamentItem>>(
      `/api/farms/${farmId.value}/spool-library/filaments`,
      { query: { sort: 'name:asc' }, retry: 0, timeout: 15_000 },
    ),
    $fetch<SpoolLibraryListResponse<VendorItem>>(
      `/api/farms/${farmId.value}/spool-library/vendors`,
      { query: { sort: 'name:asc' }, retry: 0, timeout: 15_000 },
    ),
  ])
  if (filRes.status === 'fulfilled') filaments.value = filRes.value.items
  if (venRes.status === 'fulfilled') vendors.value = venRes.value.items
}

async function loadSpools() {
  if (!farmId.value) return
  listController?.abort()
  const signal = (listController = new AbortController()).signal
  loadingList.value = true
  listError.value = ''
  try {
    const response = await $fetch<SpoolLibraryListResponse<SpoolItem>>(
      `/api/farms/${farmId.value}/spool-library/spools`,
      {
        query: buildSpoolQuery(filters),
        retry: 0,
        timeout: 15_000,
        signal,
      },
    )
    spools.value = response.items
    total.value = response.total
    canWrite.value = response.canWrite
    canImport.value = response.canImport
  } catch (cause) {
    if (signal.aborted) return
    listError.value = extractApiError(
      cause,
      'Não foi possível carregar as bobinas. Tente novamente.',
    ).message
  } finally {
    if (!signal.aborted) loadingList.value = false
  }
}

async function loadAll() {
  if (!farmId.value) return
  await Promise.all([loadSpools(), loadCatalogOptions()])
}

function clearFilters() {
  Object.assign(filters, EMPTY_SPOOL_FILTERS)
  void loadSpools()
}

function openCreate() {
  editingSpool.value = null
  formError.value = ''
  formOpen.value = true
}

function openEdit(spool: SpoolItem) {
  editingSpool.value = spool
  formError.value = ''
  formOpen.value = true
}

async function saveSpool(payload: Record<string, unknown>) {
  if (!farmId.value || formBusy.value) return
  formBusy.value = true
  formError.value = ''
  try {
    if (editingSpool.value) {
      await $fetch<SpoolLibraryItemResponse<SpoolItem>>(
        `/api/farms/${farmId.value}/spool-library/spools/${editingSpool.value.id}`,
        { method: 'PATCH', body: payload, retry: 0, timeout: 15_000 },
      )
      statusMessage.value = `Bobina #${editingSpool.value.id} atualizada.`
    } else {
      const created = await $fetch<SpoolLibraryItemResponse<SpoolItem>>(
        `/api/farms/${farmId.value}/spool-library/spools`,
        { method: 'POST', body: payload, retry: 0, timeout: 15_000 },
      )
      statusMessage.value = `Bobina #${created.item.id} cadastrada.`
    }
    formOpen.value = false
    await loadSpools()
  } catch (cause) {
    formError.value = extractApiError(
      cause,
      'Não foi possível salvar a bobina. Tente novamente.',
    ).message
  } finally {
    formBusy.value = false
  }
}

function openUseMeasure(spool: SpoolItem, mode: 'use' | 'measure') {
  actionSpool.value = spool
  actionMode.value = mode
  actionError.value = ''
  actionOpen.value = true
}

async function handleUse(payload: {
  use_weight?: number
  use_length?: number
}) {
  if (!farmId.value || !actionSpool.value || actionBusy.value) return
  actionBusy.value = true
  actionError.value = ''
  try {
    await $fetch<SpoolLibraryItemResponse<SpoolItem>>(
      `/api/farms/${farmId.value}/spool-library/spools/${actionSpool.value.id}/use`,
      { method: 'PUT', body: payload, retry: 0, timeout: 15_000 },
    )
    statusMessage.value = `Uso registrado na bobina #${actionSpool.value.id}.`
    actionOpen.value = false
    await loadSpools()
  } catch (cause) {
    actionError.value = extractApiError(
      cause,
      'Não foi possível registrar o uso da bobina.',
    ).message
  } finally {
    actionBusy.value = false
  }
}

async function handleMeasure(payload: { weight: number }) {
  if (!farmId.value || !actionSpool.value || actionBusy.value) return
  actionBusy.value = true
  actionError.value = ''
  try {
    await $fetch<SpoolLibraryItemResponse<SpoolItem>>(
      `/api/farms/${farmId.value}/spool-library/spools/${actionSpool.value.id}/measure`,
      { method: 'PUT', body: payload, retry: 0, timeout: 15_000 },
    )
    statusMessage.value = `Pesagem registrada na bobina #${actionSpool.value.id}.`
    actionOpen.value = false
    await loadSpools()
  } catch (cause) {
    actionError.value = extractApiError(
      cause,
      'Não foi possível registrar a pesagem da bobina.',
    ).message
  } finally {
    actionBusy.value = false
  }
}

async function toggleArchive(spool: SpoolItem) {
  if (!farmId.value || archivingId.value !== null) return
  archivingId.value = spool.id
  listError.value = ''
  const nextArchived = !spool.archived
  try {
    await $fetch<SpoolLibraryItemResponse<SpoolItem>>(
      `/api/farms/${farmId.value}/spool-library/spools/${spool.id}`,
      {
        method: 'PATCH',
        body: { archived: nextArchived },
        retry: 0,
        timeout: 15_000,
      },
    )
    statusMessage.value = nextArchived
      ? `Bobina #${spool.id} arquivada.`
      : `Bobina #${spool.id} desarquivada.`
    await loadSpools()
  } catch (cause) {
    listError.value = extractApiError(
      cause,
      'Não foi possível atualizar o arquivamento da bobina.',
    ).message
  } finally {
    archivingId.value = null
  }
}

function openDelete(spool: SpoolItem) {
  deletingSpool.value = spool
  deleteError.value = ''
  deleteOpen.value = true
}

async function confirmDelete() {
  if (!farmId.value || !deletingSpool.value || deleteBusy.value) return
  deleteBusy.value = true
  deleteError.value = ''
  const id = deletingSpool.value.id
  try {
    await $fetch(`/api/farms/${farmId.value}/spool-library/spools/${id}`, {
      method: 'DELETE',
      retry: 0,
      timeout: 15_000,
    })
    statusMessage.value = `Bobina #${id} excluída.`
    deleteOpen.value = false
    await loadSpools()
  } catch (cause) {
    deleteError.value = extractApiError(
      cause,
      'Não foi possível excluir a bobina.',
    ).message
  } finally {
    deleteBusy.value = false
  }
}

async function retryLoad() {
  await loadFarms()
  if (farmId.value) await loadAll()
}

onMounted(async () => {
  await loadFarms()
  if (farmId.value) await loadAll()
})

watch(farmId, (next, prev) => {
  if (next && next !== prev) void loadAll()
})

onBeforeUnmount(() => {
  listController?.abort()
})
</script>

<template>
  <SpoolLibraryShell
    section="spools"
    title="Biblioteca de bobinas"
    description="Consulte o estoque de bobinas da farm, filtre por material, fornecedor ou localização e registre consumo ou pesagem."
    :farms="farms"
    :farm-id="farmId"
    :loading="loadingFarm"
    :load-error="farmLoadError"
    :sign-in-required="signInRequired"
    :no-farm="noFarm"
    :can-import="canImport"
    :status-message="statusMessage"
    @retry="retryLoad"
    @select-farm="selectFarm"
  >
    <p v-if="!loadingList && !canWrite" role="status" class="notice">
      Modo somente leitura. Operadores, administradores e proprietários podem
      criar, editar, arquivar, excluir ou registrar uso de bobinas.
    </p>

    <section class="panel" aria-labelledby="spool-filters-heading">
      <div class="toolbar-head">
        <h2 id="spool-filters-heading">Filtros e busca</h2>
        <div v-if="canWrite" class="toolbar-actions">
          <Button
            class="primary"
            :disabled="!filaments.length"
            @click="openCreate"
          >
            Nova bobina
          </Button>
        </div>
      </div>

      <p v-if="canWrite && !loadingList && !filaments.length" class="hint-row">
        Cadastre pelo menos um filamento em
        <NuxtLink
          :to="{ path: '/bobinas/filamentos', query: { farm: farmId } }"
        >
          Filamentos
        </NuxtLink>
        antes de criar uma bobina.
      </p>

      <form class="filter-grid" @submit.prevent="loadSpools">
        <div class="filter-field">
          <label for="spool-filter-q">Buscar</label>
          <input
            id="spool-filter-q"
            v-model="filters.q"
            type="search"
            placeholder="Nome, material, lote, local ou #ID"
          />
        </div>

        <div class="filter-field">
          <label for="spool-filter-material">Material</label>
          <select
            id="spool-filter-material"
            v-model="filters.material"
            @change="loadSpools"
          >
            <option value="">Todos</option>
            <option
              v-for="material in availableMaterials"
              :key="material"
              :value="material"
            >
              {{ material }}
            </option>
          </select>
        </div>

        <div class="filter-field">
          <label for="spool-filter-vendor">Fornecedor</label>
          <select
            id="spool-filter-vendor"
            v-model="filters.vendorId"
            @change="loadSpools"
          >
            <option value="">Todos</option>
            <option
              v-for="vendor in vendors"
              :key="vendor.id"
              :value="String(vendor.id)"
            >
              {{ vendor.name }}
            </option>
          </select>
        </div>

        <div class="filter-field">
          <label for="spool-filter-location">Localização</label>
          <input
            id="spool-filter-location"
            v-model="filters.location"
            type="text"
            placeholder="Ex.: Estante A"
          />
        </div>

        <div class="filter-field">
          <label for="spool-filter-sort">Ordenar por</label>
          <select
            id="spool-filter-sort"
            v-model="filters.sort"
            @change="loadSpools"
          >
            <option
              v-for="option in SPOOL_SORT_OPTIONS"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select>
        </div>

        <label class="checkbox-inline">
          <input
            v-model="filters.allowArchived"
            type="checkbox"
            @change="loadSpools"
          />
          <span>Mostrar arquivadas</span>
        </label>

        <div class="filter-buttons">
          <Button type="submit">Filtrar</Button>
          <Button v-if="hasActiveFilters" @click="clearFilters">Limpar</Button>
        </div>
      </form>
    </section>

    <div v-if="loadingList" aria-busy="true" class="panel loading">
      <p role="status">Carregando bobinas…</p>
      <Skeleton />
      <Skeleton />
    </div>

    <ErrorState
      v-else-if="listError"
      title="Não foi possível carregar as bobinas"
      :description="listError"
    >
      <Button @click="loadSpools">Tentar novamente</Button>
    </ErrorState>

    <EmptyState
      v-else-if="!spools.length"
      title="Nenhuma bobina encontrada"
      :description="
        hasActiveFilters
          ? 'Nenhuma bobina corresponde aos filtros selecionados.'
          : 'Ainda não há bobinas cadastradas nesta farm.'
      "
    >
      <div class="empty-actions">
        <Button v-if="hasActiveFilters" @click="clearFilters">
          Limpar filtros
        </Button>
        <Button
          v-else-if="canWrite && filaments.length"
          class="primary"
          @click="openCreate"
        >
          Cadastrar primeira bobina
        </Button>
        <NuxtLink
          v-else-if="canWrite"
          :to="{ path: '/bobinas/filamentos', query: { farm: farmId } }"
          class="cta"
        >
          Cadastrar filamento
        </NuxtLink>
      </div>
    </EmptyState>

    <section
      v-else
      class="results-section"
      aria-labelledby="spools-list-heading"
    >
      <p id="spools-list-heading" role="status" class="count-summary">
        {{ total }} bobina(s) encontrada(s).
      </p>

      <div class="card-grid">
        <article
          v-for="spool in spools"
          :key="spool.id"
          class="entity-card"
          :class="{ archived: spool.archived }"
        >
          <header class="card-head">
            <div class="card-title-group">
              <ColorSwatch :filament="spool.filament" :show-label="false" />
              <div class="card-title-text">
                <h3>
                  {{ spoolDisplayTitle(spool) }}
                  <span class="record-id">#{{ spool.id }}</span>
                </h3>
                <ColorSwatch :filament="spool.filament" />
              </div>
            </div>
            <div class="badges">
              <StatusBadge
                v-if="spool.filament.material"
                tone="printing"
                :label="spool.filament.material"
              />
              <StatusBadge
                :tone="spool.archived ? 'offline' : 'idle'"
                :label="spool.archived ? 'Arquivada' : 'Ativa'"
              />
            </div>
          </header>

          <div class="stock-block">
            <div class="stock-numbers">
              <strong>
                Restante: {{ formatSpoolWeight(spool.remaining_weight) }}
              </strong>
              <span class="muted">
                de {{ formatSpoolWeight(spoolBaseWeight(spool)) }} · Usado:
                {{ formatSpoolWeight(spool.used_weight) }}
              </span>
            </div>
            <Meter
              v-if="spoolRemainingPercent(spool) !== null"
              :label="`Filamento restante da bobina #${spool.id} (${spoolRemainingPercent(spool)}%)`"
              :value="spoolRemainingPercent(spool) ?? 0"
            />
          </div>

          <dl class="meta-list">
            <div>
              <dt>Comprimento restante</dt>
              <dd>{{ formatSpoolLength(spool.remaining_length) }}</dd>
            </div>
            <div>
              <dt>Localização</dt>
              <dd>{{ spool.location || '—' }}</dd>
            </div>
            <div>
              <dt>Lote</dt>
              <dd>{{ spool.lot_nr || '—' }}</dd>
            </div>
            <div>
              <dt>Preço</dt>
              <dd>{{ formatPrice(spool.price ?? spool.filament.price) }}</dd>
            </div>
            <div>
              <dt>Último uso</dt>
              <dd>{{ formatIsoDate(spool.last_used) }}</dd>
            </div>
            <div v-if="spool.comment" class="full-span">
              <dt>Observações</dt>
              <dd>{{ spool.comment }}</dd>
            </div>
          </dl>

          <div v-if="canWrite" class="card-actions">
            <Button
              :aria-label="`Registrar uso da bobina #${spool.id}`"
              @click="openUseMeasure(spool, 'use')"
            >
              Registrar uso
            </Button>
            <Button
              :aria-label="`Pesar bobina #${spool.id}`"
              @click="openUseMeasure(spool, 'measure')"
            >
              Pesar
            </Button>
            <Button
              :aria-label="`Editar bobina #${spool.id}`"
              @click="openEdit(spool)"
            >
              Editar
            </Button>
            <Button
              :disabled="archivingId === spool.id"
              :aria-label="
                spool.archived
                  ? `Desarquivar bobina #${spool.id}`
                  : `Arquivar bobina #${spool.id}`
              "
              @click="toggleArchive(spool)"
            >
              {{ spool.archived ? 'Desarquivar' : 'Arquivar' }}
            </Button>
            <Button
              class="danger"
              :aria-label="`Excluir bobina #${spool.id}`"
              @click="openDelete(spool)"
            >
              Excluir
            </Button>
          </div>
        </article>
      </div>
    </section>

    <SpoolFormDialog
      v-model="formOpen"
      :spool="editingSpool"
      :filaments="filaments"
      :busy="formBusy"
      :server-error="formError"
      @save="saveSpool"
    />

    <SpoolUseMeasureDialog
      v-model="actionOpen"
      :spool="actionSpool"
      :mode="actionMode"
      :busy="actionBusy"
      :server-error="actionError"
      @submit-use="handleUse"
      @submit-measure="handleMeasure"
    />

    <ConfirmDeleteDialog
      v-model="deleteOpen"
      :title="
        deletingSpool ? `Excluir bobina #${deletingSpool.id}` : 'Excluir bobina'
      "
      :description="
        deletingSpool
          ? `Deseja excluir permanentemente a bobina #${deletingSpool.id} (${spoolDisplayTitle(deletingSpool)})? Esta ação não pode ser desfeita.`
          : ''
      "
      :busy="deleteBusy"
      :error="deleteError"
      @confirm="confirmDelete"
    />
  </SpoolLibraryShell>
</template>

<style scoped>
.panel {
  display: grid;
  gap: var(--space-3);
  min-width: 0;
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
}
.panel h2 {
  margin: 0;
  font-size: var(--font-size-lg);
}
.notice {
  margin: 0;
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-inline-start: var(--space-1) solid var(--color-accent);
  border-radius: var(--radius-sm);
  background: var(--color-surface-raised);
}
.hint-row {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}
.toolbar-head {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-2);
}
.toolbar-actions,
.filter-buttons,
.empty-actions,
.card-actions,
.badges {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: center;
}
.filter-grid {
  display: grid;
  gap: var(--space-3);
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 11rem), 1fr));
  align-items: end;
}
.filter-field {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
  font-weight: var(--font-weight-semibold);
  font-size: var(--font-size-sm);
}
.filter-field input,
.filter-field select {
  width: 100%;
  min-height: 2.75rem;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-text-muted);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text);
  font: inherit;
}
.filter-field input:focus-visible,
.filter-field select:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.checkbox-inline {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 2.75rem;
  font-weight: var(--font-weight-semibold);
  font-size: var(--font-size-sm);
}
.checkbox-inline input {
  inline-size: 1.25rem;
  block-size: 1.25rem;
}
.loading :deep(.skeleton) {
  min-block-size: var(--space-5);
}
.results-section {
  display: grid;
  gap: var(--space-3);
  min-width: 0;
}
.count-summary {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}
.card-grid {
  display: grid;
  gap: var(--space-4);
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 22rem), 1fr));
  min-width: 0;
}
.entity-card {
  display: grid;
  gap: var(--space-3);
  align-content: start;
  min-width: 0;
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
}
.entity-card.archived {
  border-style: dashed;
}
.card-head {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--space-2);
  min-width: 0;
}
.card-title-group {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  min-width: 0;
}
.card-title-text {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
}
.card-title-text h3 {
  margin: 0;
  font-size: var(--font-size-lg);
  line-height: var(--line-height-tight);
  overflow-wrap: anywhere;
}
.record-id {
  font-size: var(--font-size-sm);
  font-weight: 400;
  color: var(--color-text-muted);
}
.stock-block {
  display: grid;
  gap: var(--space-2);
}
.stock-numbers {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: baseline;
}
.muted {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}
.meta-list {
  display: grid;
  gap: var(--space-2);
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 8.5rem), 1fr));
  margin: 0;
}
.meta-list > div {
  min-width: 0;
}
.meta-list .full-span {
  grid-column: 1 / -1;
}
.meta-list dt {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}
.meta-list dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.primary {
  background: var(--color-accent);
  color: var(--color-on-accent);
  font-weight: var(--font-weight-semibold);
}
.danger {
  border-color: var(--printer-error);
  color: var(--printer-error);
}
.cta {
  display: inline-flex;
  align-items: center;
  min-height: 2.75rem;
  padding: var(--space-2) var(--space-4);
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-sm);
  font-weight: var(--font-weight-semibold);
  text-decoration: none;
}
@media (max-width: 30rem) {
  .panel,
  .entity-card {
    padding: var(--space-3);
  }
}
</style>
