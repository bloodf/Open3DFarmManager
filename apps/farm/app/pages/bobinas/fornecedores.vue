<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import Button from '../../components/ui/Button.vue'
import EmptyState from '../../components/ui/EmptyState.vue'
import ErrorState from '../../components/ui/ErrorState.vue'
import Skeleton from '../../components/ui/Skeleton.vue'
import ConfirmDeleteDialog from '../../components/spool-library/ConfirmDeleteDialog.vue'
import SpoolLibraryShell from '../../components/spool-library/SpoolLibraryShell.vue'
import VendorFormDialog from '../../components/spool-library/VendorFormDialog.vue'
import { useSpoolLibraryFarm } from '../../composables/useSpoolLibraryFarm.ts'
import {
  buildVendorQuery,
  EMPTY_VENDOR_FILTERS,
  extractApiError,
  formatIsoDate,
  formatSpoolWeight,
  VENDOR_SORT_OPTIONS,
} from '../../utils/spool-library-format.ts'
import type {
  SpoolLibraryItemResponse,
  SpoolLibraryListResponse,
  VendorFilters,
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

const vendors = ref<VendorItem[]>([])
const total = ref(0)
const canWrite = ref(false)
const canImport = ref(false)
const loadingList = ref(false)
const listError = ref('')
const statusMessage = ref('')

const filters = reactive<VendorFilters>({ ...EMPTY_VENDOR_FILTERS })

const formOpen = ref(false)
const editingVendor = ref<VendorItem | null>(null)
const formBusy = ref(false)
const formError = ref('')

const deleteOpen = ref(false)
const deletingVendor = ref<VendorItem | null>(null)
const deleteBusy = ref(false)
const deleteError = ref('')

let listController: AbortController | undefined

const hasActiveFilters = computed(() => Boolean(filters.q.trim()))

async function loadVendors() {
  if (!farmId.value) return
  listController?.abort()
  const signal = (listController = new AbortController()).signal
  loadingList.value = true
  listError.value = ''
  try {
    const response = await $fetch<SpoolLibraryListResponse<VendorItem>>(
      `/api/farms/${farmId.value}/spool-library/vendors`,
      {
        query: buildVendorQuery(filters),
        retry: 0,
        timeout: 15_000,
        signal,
      },
    )
    vendors.value = response.items
    total.value = response.total
    canWrite.value = response.canWrite
    canImport.value = response.canImport
  } catch (cause) {
    if (signal.aborted) return
    listError.value = extractApiError(
      cause,
      'Não foi possível carregar os fornecedores. Tente novamente.',
    ).message
  } finally {
    if (!signal.aborted) loadingList.value = false
  }
}

function clearFilters() {
  Object.assign(filters, EMPTY_VENDOR_FILTERS)
  void loadVendors()
}

function openCreate() {
  editingVendor.value = null
  formError.value = ''
  formOpen.value = true
}

function openEdit(vendor: VendorItem) {
  editingVendor.value = vendor
  formError.value = ''
  formOpen.value = true
}

async function saveVendor(payload: Record<string, unknown>) {
  if (!farmId.value || formBusy.value) return
  formBusy.value = true
  formError.value = ''
  try {
    if (editingVendor.value) {
      await $fetch<SpoolLibraryItemResponse<VendorItem>>(
        `/api/farms/${farmId.value}/spool-library/vendors/${editingVendor.value.id}`,
        { method: 'PATCH', body: payload, retry: 0, timeout: 15_000 },
      )
      statusMessage.value = `Fornecedor #${editingVendor.value.id} atualizado.`
    } else {
      const created = await $fetch<SpoolLibraryItemResponse<VendorItem>>(
        `/api/farms/${farmId.value}/spool-library/vendors`,
        { method: 'POST', body: payload, retry: 0, timeout: 15_000 },
      )
      statusMessage.value = `Fornecedor #${created.item.id} cadastrado.`
    }
    formOpen.value = false
    await loadVendors()
  } catch (cause) {
    formError.value = extractApiError(
      cause,
      'Não foi possível salvar o fornecedor. Tente novamente.',
    ).message
  } finally {
    formBusy.value = false
  }
}

function openDelete(vendor: VendorItem) {
  deletingVendor.value = vendor
  deleteError.value = ''
  deleteOpen.value = true
}

async function confirmDelete() {
  if (!farmId.value || !deletingVendor.value || deleteBusy.value) return
  deleteBusy.value = true
  deleteError.value = ''
  const id = deletingVendor.value.id
  try {
    await $fetch(`/api/farms/${farmId.value}/spool-library/vendors/${id}`, {
      method: 'DELETE',
      retry: 0,
      timeout: 15_000,
    })
    statusMessage.value = `Fornecedor #${id} excluído.`
    deleteOpen.value = false
    await loadVendors()
  } catch (cause) {
    deleteError.value = extractApiError(
      cause,
      'Não foi possível excluir o fornecedor.',
    ).message
  } finally {
    deleteBusy.value = false
  }
}

async function retryLoad() {
  await loadFarms()
  if (farmId.value) await loadVendors()
}

onMounted(async () => {
  await loadFarms()
  if (farmId.value) await loadVendors()
})

watch(farmId, (next, prev) => {
  if (next && next !== prev) void loadVendors()
})

onBeforeUnmount(() => {
  listController?.abort()
})
</script>

<template>
  <SpoolLibraryShell
    section="vendors"
    title="Fornecedores"
    description="Cadastre fabricantes e fornecedores de filamento com peso padrão do carretel vazio."
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
      criar, editar ou excluir fornecedores.
    </p>

    <section class="panel" aria-labelledby="vendor-filters-heading">
      <div class="toolbar-head">
        <h2 id="vendor-filters-heading">Filtros e busca</h2>
        <div v-if="canWrite" class="toolbar-actions">
          <Button class="primary" @click="openCreate">Novo fornecedor</Button>
        </div>
      </div>

      <form class="filter-grid" @submit.prevent="loadVendors">
        <div class="filter-field">
          <label for="vendor-filter-q">Buscar</label>
          <input
            id="vendor-filter-q"
            v-model="filters.q"
            type="search"
            placeholder="Nome, observações ou ID externo"
          />
        </div>

        <div class="filter-field">
          <label for="vendor-filter-sort">Ordenar por</label>
          <select
            id="vendor-filter-sort"
            v-model="filters.sort"
            @change="loadVendors"
          >
            <option
              v-for="option in VENDOR_SORT_OPTIONS"
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
      <p role="status">Carregando fornecedores…</p>
      <Skeleton />
      <Skeleton />
    </div>

    <ErrorState
      v-else-if="listError"
      title="Não foi possível carregar os fornecedores"
      :description="listError"
    >
      <Button @click="loadVendors">Tentar novamente</Button>
    </ErrorState>

    <EmptyState
      v-else-if="!vendors.length"
      title="Nenhum fornecedor encontrado"
      :description="
        hasActiveFilters
          ? 'Nenhum fornecedor corresponde à busca informada.'
          : 'Cadastre os fabricantes usados na sua farm.'
      "
    >
      <Button v-if="hasActiveFilters" @click="clearFilters">
        Limpar filtros
      </Button>
      <Button v-else-if="canWrite" class="primary" @click="openCreate">
        Cadastrar primeiro fornecedor
      </Button>
    </EmptyState>

    <section
      v-else
      class="results-section"
      aria-labelledby="vendors-list-heading"
    >
      <p id="vendors-list-heading" role="status" class="count-summary">
        {{ total }} fornecedor(es) encontrado(s).
      </p>

      <div class="card-grid">
        <article v-for="vendor in vendors" :key="vendor.id" class="entity-card">
          <header class="card-head">
            <h3>
              {{ vendor.name }}
              <span class="record-id">#{{ vendor.id }}</span>
            </h3>
          </header>

          <dl class="meta-list">
            <div>
              <dt>Carretel vazio padrão</dt>
              <dd>{{ formatSpoolWeight(vendor.empty_spool_weight) }}</dd>
            </div>
            <div>
              <dt>Cadastrado em</dt>
              <dd>{{ formatIsoDate(vendor.registered) }}</dd>
            </div>
            <div v-if="vendor.external_id">
              <dt>ID externo</dt>
              <dd>{{ vendor.external_id }}</dd>
            </div>
            <div v-if="vendor.comment" class="full-span">
              <dt>Observações</dt>
              <dd>{{ vendor.comment }}</dd>
            </div>
          </dl>

          <div v-if="canWrite" class="card-actions">
            <Button
              :aria-label="`Editar fornecedor #${vendor.id}`"
              @click="openEdit(vendor)"
            >
              Editar
            </Button>
            <Button
              class="danger"
              :aria-label="`Excluir fornecedor #${vendor.id}`"
              @click="openDelete(vendor)"
            >
              Excluir
            </Button>
          </div>
        </article>
      </div>
    </section>

    <VendorFormDialog
      v-model="formOpen"
      :vendor="editingVendor"
      :busy="formBusy"
      :server-error="formError"
      @save="saveVendor"
    />

    <ConfirmDeleteDialog
      v-model="deleteOpen"
      :title="
        deletingVendor
          ? `Excluir fornecedor #${deletingVendor.id}`
          : 'Excluir fornecedor'
      "
      :description="
        deletingVendor
          ? `Deseja excluir o fornecedor #${deletingVendor.id} (${deletingVendor.name})? Filamentos associados ficarão sem fornecedor.`
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
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 20rem), 1fr));
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
.card-head h3 {
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
