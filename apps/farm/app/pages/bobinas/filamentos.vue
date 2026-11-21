<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import Button from '../../components/ui/Button.vue'
import EmptyState from '../../components/ui/EmptyState.vue'
import ErrorState from '../../components/ui/ErrorState.vue'
import Skeleton from '../../components/ui/Skeleton.vue'
import StatusBadge from '../../components/ui/StatusBadge.vue'
import ColorSwatch from '../../components/spool-library/ColorSwatch.vue'
import ConfirmDeleteDialog from '../../components/spool-library/ConfirmDeleteDialog.vue'
import FilamentFormDialog from '../../components/spool-library/FilamentFormDialog.vue'
import SpoolLibraryShell from '../../components/spool-library/SpoolLibraryShell.vue'
import { useSpoolLibraryFarm } from '../../composables/useSpoolLibraryFarm.ts'
import {
  buildFilamentQuery,
  distinctMaterials,
  EMPTY_FILAMENT_FILTERS,
  extractApiError,
  FILAMENT_SORT_OPTIONS,
  filamentDisplayTitle,
  formatPrice,
  formatSpoolWeight,
} from '../../utils/spool-library-format.ts'
import { formatNumber, formatTemperature } from '../../utils/ui-format.ts'
import type {
  FilamentFilters,
  FilamentItem,
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

const filaments = ref<FilamentItem[]>([])
const total = ref(0)
const vendors = ref<VendorItem[]>([])
const canWrite = ref(false)
const canImport = ref(false)
const loadingList = ref(false)
const listError = ref('')
const statusMessage = ref('')

const filters = reactive<FilamentFilters>({ ...EMPTY_FILAMENT_FILTERS })

const formOpen = ref(false)
const editingFilament = ref<FilamentItem | null>(null)
const formBusy = ref(false)
const formError = ref('')

const deleteOpen = ref(false)
const deletingFilament = ref<FilamentItem | null>(null)
const deleteBusy = ref(false)
const deleteError = ref('')

let listController: AbortController | undefined

const availableMaterials = computed(() => distinctMaterials(filaments.value))

const hasActiveFilters = computed(() =>
  Boolean(
    filters.q.trim() || filters.material.trim() || filters.vendorId.trim(),
  ),
)

async function loadVendors() {
  if (!farmId.value) return
  try {
    const response = await $fetch<SpoolLibraryListResponse<VendorItem>>(
      `/api/farms/${farmId.value}/spool-library/vendors`,
      { query: { sort: 'name:asc' }, retry: 0, timeout: 15_000 },
    )
    vendors.value = response.items
  } catch {
    vendors.value = []
  }
}

async function loadFilaments() {
  if (!farmId.value) return
  listController?.abort()
  const signal = (listController = new AbortController()).signal
  loadingList.value = true
  listError.value = ''
  try {
    const response = await $fetch<SpoolLibraryListResponse<FilamentItem>>(
      `/api/farms/${farmId.value}/spool-library/filaments`,
      {
        query: buildFilamentQuery(filters),
        retry: 0,
        timeout: 15_000,
        signal,
      },
    )
    filaments.value = response.items
    total.value = response.total
    canWrite.value = response.canWrite
    canImport.value = response.canImport
  } catch (cause) {
    if (signal.aborted) return
    listError.value = extractApiError(
      cause,
      'Não foi possível carregar os filamentos. Tente novamente.',
    ).message
  } finally {
    if (!signal.aborted) loadingList.value = false
  }
}

async function loadAll() {
  if (!farmId.value) return
  await Promise.all([loadFilaments(), loadVendors()])
}

function clearFilters() {
  Object.assign(filters, EMPTY_FILAMENT_FILTERS)
  void loadFilaments()
}

function openCreate() {
  editingFilament.value = null
  formError.value = ''
  formOpen.value = true
}

function openEdit(filament: FilamentItem) {
  editingFilament.value = filament
  formError.value = ''
  formOpen.value = true
}

async function saveFilament(payload: Record<string, unknown>) {
  if (!farmId.value || formBusy.value) return
  formBusy.value = true
  formError.value = ''
  try {
    if (editingFilament.value) {
      await $fetch<SpoolLibraryItemResponse<FilamentItem>>(
        `/api/farms/${farmId.value}/spool-library/filaments/${editingFilament.value.id}`,
        { method: 'PATCH', body: payload, retry: 0, timeout: 15_000 },
      )
      statusMessage.value = `Filamento #${editingFilament.value.id} atualizado.`
    } else {
      const created = await $fetch<SpoolLibraryItemResponse<FilamentItem>>(
        `/api/farms/${farmId.value}/spool-library/filaments`,
        { method: 'POST', body: payload, retry: 0, timeout: 15_000 },
      )
      statusMessage.value = `Filamento #${created.item.id} cadastrado.`
    }
    formOpen.value = false
    await loadFilaments()
  } catch (cause) {
    formError.value = extractApiError(
      cause,
      'Não foi possível salvar o filamento. Tente novamente.',
    ).message
  } finally {
    formBusy.value = false
  }
}

function openDelete(filament: FilamentItem) {
  deletingFilament.value = filament
  deleteError.value = ''
  deleteOpen.value = true
}

async function confirmDelete() {
  if (!farmId.value || !deletingFilament.value || deleteBusy.value) return
  deleteBusy.value = true
  deleteError.value = ''
  const id = deletingFilament.value.id
  try {
    await $fetch(`/api/farms/${farmId.value}/spool-library/filaments/${id}`, {
      method: 'DELETE',
      retry: 0,
      timeout: 15_000,
    })
    statusMessage.value = `Filamento #${id} excluído.`
    deleteOpen.value = false
    await loadFilaments()
  } catch (cause) {
    deleteError.value = extractApiError(
      cause,
      'Não foi possível excluir o filamento.',
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
    section="filaments"
    title="Filamentos"
    description="Catálogo de filamentos da farm com material, cores, temperaturas e especificações."
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
      criar, editar ou excluir filamentos.
    </p>

    <section class="panel" aria-labelledby="filament-filters-heading">
      <div class="toolbar-head">
        <h2 id="filament-filters-heading">Filtros e busca</h2>
        <div v-if="canWrite" class="toolbar-actions">
          <Button class="primary" @click="openCreate">Novo filamento</Button>
        </div>
      </div>

      <form class="filter-grid" @submit.prevent="loadFilaments">
        <div class="filter-field">
          <label for="filament-filter-q">Buscar</label>
          <input
            id="filament-filter-q"
            v-model="filters.q"
            type="search"
            placeholder="Nome, material, fornecedor ou código"
          />
        </div>

        <div class="filter-field">
          <label for="filament-filter-material">Material</label>
          <select
            id="filament-filter-material"
            v-model="filters.material"
            @change="loadFilaments"
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
          <label for="filament-filter-vendor">Fornecedor</label>
          <select
            id="filament-filter-vendor"
            v-model="filters.vendorId"
            @change="loadFilaments"
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
          <label for="filament-filter-sort">Ordenar por</label>
          <select
            id="filament-filter-sort"
            v-model="filters.sort"
            @change="loadFilaments"
          >
            <option
              v-for="option in FILAMENT_SORT_OPTIONS"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select>
        </div>

        <div class="filter-buttons">
          <Button type="submit">Filtrar</Button>
          <Button v-if="hasActiveFilters" @click="clearFilters">Limpar</Button>
        </div>
      </form>
    </section>

    <div v-if="loadingList" aria-busy="true" class="panel loading">
      <p role="status">Carregando filamentos…</p>
      <Skeleton />
      <Skeleton />
    </div>

    <ErrorState
      v-else-if="listError"
      title="Não foi possível carregar os filamentos"
      :description="listError"
    >
      <Button @click="loadFilaments">Tentar novamente</Button>
    </ErrorState>

    <EmptyState
      v-else-if="!filaments.length"
      title="Nenhum filamento encontrado"
      :description="
        hasActiveFilters
          ? 'Nenhum filamento corresponde aos filtros selecionados.'
          : 'Cadastre um filamento para associar às suas bobinas.'
      "
    >
      <Button v-if="hasActiveFilters" @click="clearFilters">
        Limpar filtros
      </Button>
      <Button v-else-if="canWrite" class="primary" @click="openCreate">
        Cadastrar primeiro filamento
      </Button>
    </EmptyState>

    <section
      v-else
      class="results-section"
      aria-labelledby="filaments-list-heading"
    >
      <p id="filaments-list-heading" role="status" class="count-summary">
        {{ total }} filamento(s) encontrado(s).
      </p>

      <div class="card-grid">
        <article
          v-for="filament in filaments"
          :key="filament.id"
          class="entity-card"
        >
          <header class="card-head">
            <div class="card-title-group">
              <ColorSwatch :filament="filament" :show-label="false" />
              <div class="card-title-text">
                <h3>
                  {{ filamentDisplayTitle(filament) }}
                  <span class="record-id">#{{ filament.id }}</span>
                </h3>
                <ColorSwatch :filament="filament" />
              </div>
            </div>
            <StatusBadge
              v-if="filament.material"
              tone="printing"
              :label="filament.material"
            />
          </header>

          <dl class="meta-list">
            <div>
              <dt>Fornecedor</dt>
              <dd>{{ filament.vendor?.name || 'Sem fornecedor' }}</dd>
            </div>
            <div>
              <dt>Diâmetro / Densidade</dt>
              <dd>
                {{
                  formatNumber(filament.diameter, { maximumFractionDigits: 2 })
                }}
                mm ·
                {{
                  formatNumber(filament.density, { maximumFractionDigits: 2 })
                }}
                g/cm³
              </dd>
            </div>
            <div>
              <dt>Peso líquido</dt>
              <dd>{{ formatSpoolWeight(filament.weight) }}</dd>
            </div>
            <div>
              <dt>Carretel vazio</dt>
              <dd>{{ formatSpoolWeight(filament.spool_weight) }}</dd>
            </div>
            <div>
              <dt>Bico / Mesa</dt>
              <dd>
                {{ formatTemperature(filament.settings_extruder_temp) ?? '—' }}
                /
                {{ formatTemperature(filament.settings_bed_temp) ?? '—' }}
              </dd>
            </div>
            <div>
              <dt>Preço</dt>
              <dd>{{ formatPrice(filament.price) }}</dd>
            </div>
            <div v-if="filament.article_number">
              <dt>Código do artigo</dt>
              <dd>{{ filament.article_number }}</dd>
            </div>
            <div v-if="filament.comment" class="full-span">
              <dt>Observações</dt>
              <dd>{{ filament.comment }}</dd>
            </div>
          </dl>

          <div v-if="canWrite" class="card-actions">
            <Button
              :aria-label="`Editar filamento #${filament.id}`"
              @click="openEdit(filament)"
            >
              Editar
            </Button>
            <Button
              class="danger"
              :aria-label="`Excluir filamento #${filament.id}`"
              @click="openDelete(filament)"
            >
              Excluir
            </Button>
          </div>
        </article>
      </div>
    </section>

    <FilamentFormDialog
      v-model="formOpen"
      :filament="editingFilament"
      :vendors="vendors"
      :busy="formBusy"
      :server-error="formError"
      @save="saveFilament"
    />

    <ConfirmDeleteDialog
      v-model="deleteOpen"
      :title="
        deletingFilament
          ? `Excluir filamento #${deletingFilament.id}`
          : 'Excluir filamento'
      "
      :description="
        deletingFilament
          ? `Deseja excluir o filamento #${deletingFilament.id} (${filamentDisplayTitle(deletingFilament)})? Filamentos ainda usados por bobinas não podem ser excluídos.`
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
.toolbar-head {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-2);
}
.toolbar-actions,
.filter-buttons,
.card-actions {
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
@media (max-width: 30rem) {
  .panel,
  .entity-card {
    padding: var(--space-3);
  }
}
</style>
