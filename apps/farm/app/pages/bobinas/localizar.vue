<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import Button from '../../components/ui/Button.vue'
import EmptyState from '../../components/ui/EmptyState.vue'
import ErrorState from '../../components/ui/ErrorState.vue'
import Skeleton from '../../components/ui/Skeleton.vue'
import SpoolArt from '../../components/spool-library/SpoolArt.vue'
import ColorSwatch from '../../components/spool-library/ColorSwatch.vue'
import FeaturePanel from '../../components/spool-library/FeaturePanel.vue'
import FeatureTable from '../../components/spool-library/FeatureTable.vue'
import SpoolLibraryShell from '../../components/spool-library/SpoolLibraryShell.vue'
import {
  COLOR_NAMES,
  distinctValues,
  EMPTY_FINDER_FILTERS,
  filterSpools,
  type FinderFilters,
} from '../../components/spool-finder/finder-filter.ts'
import { loadFinderSpools } from '../../components/spool-finder/finder-load.ts'
import {
  fetchSpools,
  featureFetch,
  useSpoolFeaturePage,
} from '../../composables/useSpoolFeaturePage.ts'
import {
  extractApiError,
  spoolDisplayTitle,
} from '../../utils/spool-library-format.ts'
import type { SlotAssignment } from '../../utils/spool-features-types.ts'
import type { SpoolItem } from '../../utils/spool-library-types.ts'

const spools = ref<SpoolItem[]>([])
const canWrite = ref(false)
const assignments = ref<SlotAssignment[] | null>(null)
const filters = ref<FinderFilters>({ ...EMPTY_FINDER_FILTERS })

async function load(id: string, current: () => boolean, signal: AbortSignal) {
  assignments.value = null
  const [list, slots] = await Promise.all([
    loadFinderSpools(id, current, (farm) => fetchSpools(farm, signal)),
    featureFetch<{ assignments: SlotAssignment[] }>(id, 'slots', {
      signal,
    }).catch(() => null),
  ])
  if (!list || !current()) return
  spools.value = list.items
  canWrite.value = list.canWrite
  assignments.value = slots?.assignments ?? null
}

const page = useSpoolFeaturePage(load)
const {
  farms,
  farmId,
  loadingFarm,
  farmLoadError,
  signInRequired,
  noFarm,
  loading,
  error,
  statusMessage,
  selectFarm,
} = page

const columns = [
  { id: 'rank', label: 'Ordem' },
  { id: 'spool', label: 'Bobina' },
  { id: 'color', label: 'Cor' },
  { id: 'material', label: 'Material' },
  { id: 'location', label: 'Local' },
  { id: 'remaining', label: 'Restante' },
  { id: 'loaded', label: 'Em uso' },
] as const

const results = computed(() =>
  filterSpools(spools.value, filters.value).sort(
    (a, b) =>
      (b.remaining_weight ?? -1) - (a.remaining_weight ?? -1) || a.id - b.id,
  ),
)
function loadedState(id: number): string {
  if (!assignments.value) return 'Não informado'
  const active = assignments.value.filter(
    (item) => item.spoolId === id && item.unassignedAt === null,
  )
  return active.length
    ? `Atribuída a ${active.map((item) => item.printerId).join(', ')}`
    : 'Não atribuída'
}
const materials = computed(() =>
  distinctValues(spools.value.map((spool) => spool.filament.material)),
)
const locations = computed(() =>
  distinctValues(spools.value.map((spool) => spool.location)),
)
const filtering = computed(
  () => JSON.stringify(filters.value) !== JSON.stringify(EMPTY_FINDER_FILTERS),
)
const summary = computed(() => {
  const count = results.value.length
  return count === 1 ? '1 bobina encontrada.' : `${count} bobinas encontradas.`
})

function clearFilters() {
  filters.value = { ...EMPTY_FINDER_FILTERS }
}

function grams(value: number | undefined): string {
  return value === undefined
    ? 'Não informado'
    : `${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 }).format(value)} g`
}

// Scan by label: one submit, one request; a duplicate submit while busy is ignored.
const scanLocation = ref('')
const scanLabel = ref('')
const scanning = ref(false)
const scanOutcome = ref<{ kind: 'ok' | 'error'; message: string } | null>(null)
const labelInput = ref<HTMLInputElement | null>(null)
let generation = 0
let scanController = new AbortController()
watch(
  farmId,
  () => {
    generation++
    scanController.abort()
    scanController = new AbortController()
    spools.value = []
    assignments.value = null
    canWrite.value = false
    scanOutcome.value = null
    scanLabel.value = ''
    scanLocation.value = ''
    scanning.value = false
  },
  { flush: 'sync' },
)
onBeforeUnmount(() => {
  generation++
  scanController.abort()
})

async function scan() {
  if (scanning.value) return
  const label = scanLabel.value.trim()
  const location = scanLocation.value.trim()
  if (!location) {
    scanOutcome.value = {
      kind: 'error',
      message: 'Informe o local antes de escanear a etiqueta.',
    }
    return
  }
  if (!label) {
    scanOutcome.value = {
      kind: 'error',
      message: 'Escaneie ou digite a etiqueta da bobina.',
    }
    return
  }
  const id = farmId.value
  const currentGeneration = generation
  const signal = scanController.signal
  const current = () =>
    id === farmId.value && currentGeneration === generation && !signal.aborted
  scanning.value = true
  scanOutcome.value = null
  try {
    const result = await $fetch<{
      status: 'moved' | 'unchanged'
      spoolId: number
      to: string
      message: string
    }>(`/api/spool-finder/${id}/scan`, {
      method: 'POST',
      signal,
      body: { label, location },
      retry: 0,
      timeout: 15_000,
    })
    if (!current()) return
    spools.value = spools.value.map((spool) =>
      spool.id === result.spoolId ? { ...spool, location: result.to } : spool,
    )
    scanOutcome.value = { kind: 'ok', message: result.message }
    scanLabel.value = ''
  } catch (cause) {
    if (!current()) return
    scanOutcome.value = {
      kind: 'error',
      message: extractApiError(
        cause,
        'Não foi possível registrar o local. Nada foi repetido automaticamente.',
      ).message,
    }
  } finally {
    if (current()) {
      scanning.value = false
      await nextTick()
      if (current()) labelInput.value?.focus()
    }
  }
}
</script>

<template>
  <SpoolLibraryShell
    section="finder"
    title="Localizar bobinas"
    description="Encontre bobinas por cor, material e local, ou escaneie a etiqueta para registrar onde a bobina foi guardada."
    :farms="farms"
    :farm-id="farmId"
    :loading="loadingFarm"
    :load-error="farmLoadError"
    :sign-in-required="signInRequired"
    :no-farm="noFarm"
    :status-message="statusMessage"
    @retry="page.retry"
    @select-farm="selectFarm"
  >
    <div v-if="loading" aria-busy="true">
      <p role="status">Carregando bobinas…</p>
      <Skeleton />
    </div>
    <ErrorState
      v-else-if="error"
      title="Não foi possível carregar as bobinas"
      :description="error"
    >
      <Button @click="page.reload">Tentar novamente</Button>
    </ErrorState>
    <template v-else>
      <FeaturePanel
        title="Escanear etiqueta"
        description="Informe o local e escaneie a etiqueta QR da bobina. Escanear de novo no mesmo local não altera nada."
      >
        <form
          v-if="canWrite"
          class="feature-form"
          aria-label="Registrar local por etiqueta"
          @submit.prevent="scan"
        >
          <label class="feature-field">
            Local
            <input
              v-model="scanLocation"
              type="text"
              maxlength="64"
              autocomplete="off"
              list="finder-locations"
            />
          </label>
          <label class="feature-field">
            Etiqueta da bobina
            <input
              ref="labelInput"
              v-model="scanLabel"
              type="text"
              autocomplete="off"
              spellcheck="false"
              placeholder="Escaneie ou digite #12"
            />
          </label>
          <Button type="submit" :disabled="scanning">
            {{ scanning ? 'Registrando…' : 'Registrar local' }}
          </Button>
        </form>
        <p v-else class="feature-muted" role="status">
          Sua conta pode consultar as bobinas, mas não alterar o local delas.
        </p>
        <p
          v-if="scanOutcome"
          :role="scanOutcome.kind === 'error' ? 'alert' : 'status'"
          :class="scanOutcome.kind === 'error' ? 'error-line' : 'ok-line'"
        >
          {{ scanOutcome.message }}
        </p>
      </FeaturePanel>

      <FeaturePanel
        title="Buscar bobinas"
        description="Combine os filtros para achar a bobina certa. Os resultados aparecem por quantidade restante, da maior para a menor."
      >
        <form
          class="feature-form"
          role="search"
          aria-label="Buscar bobinas"
          @submit.prevent
        >
          <label class="feature-field">
            Texto
            <input
              v-model="filters.text"
              type="search"
              autocomplete="off"
              placeholder="Nome, fornecedor, lote ou #12"
            />
          </label>
          <label class="feature-field">
            Material
            <select v-model="filters.material">
              <option value="">Todos</option>
              <option v-for="material in materials" :key="material">
                {{ material }}
              </option>
            </select>
          </label>
          <label class="feature-field">
            Cor
            <input
              v-model="filters.color"
              type="text"
              autocomplete="off"
              list="finder-colors"
              placeholder="Ex.: azul ou #1F4FE0"
            />
          </label>
          <label class="feature-field">
            Local
            <input
              v-model="filters.location"
              type="text"
              autocomplete="off"
              list="finder-locations"
              :disabled="filters.withoutLocation"
            />
          </label>
          <label class="check">
            <input v-model="filters.withoutLocation" type="checkbox" />
            Somente bobinas sem local
          </label>
          <label class="check">
            <input v-model="filters.includeArchived" type="checkbox" />
            Incluir bobinas arquivadas
          </label>
          <Button :disabled="!filtering" @click="clearFilters">
            Limpar filtros
          </Button>
        </form>
        <datalist id="finder-locations">
          <option
            v-for="location in locations"
            :key="location"
            :value="location"
          />
        </datalist>
        <datalist id="finder-colors">
          <option
            v-for="name in Object.keys(COLOR_NAMES)"
            :key="name"
            :value="name"
          />
        </datalist>

        <p class="feature-muted" role="status" aria-live="polite">
          {{ summary }}
        </p>
        <EmptyState
          v-if="!results.length"
          :title="
            spools.length
              ? 'Nenhuma bobina encontrada'
              : 'Nenhuma bobina cadastrada'
          "
          :description="
            spools.length
              ? 'Ajuste ou limpe os filtros para ver mais bobinas.'
              : 'Cadastre uma bobina para localizá-la aqui.'
          "
        />
        <FeatureTable v-else caption="Bobinas encontradas" :columns="columns">
          <tr v-for="(spool, index) in results" :key="spool.id">
            <td>{{ index + 1 }}</td>
            <td>
              #{{ spool.id }} · {{ spoolDisplayTitle(spool) }}
              <span v-if="spool.archived"> (arquivada)</span>
            </td>
            <td>
              <SpoolArt :spool="spool" :size="40" />
              <ColorSwatch :filament="spool.filament" />
            </td>
            <td>{{ spool.filament.material ?? 'Não informado' }}</td>
            <td>{{ spool.location || 'Sem local' }}</td>
            <td>{{ grams(spool.remaining_weight) }}</td>
            <td>{{ loadedState(spool.id) }}</td>
          </tr>
        </FeatureTable>
      </FeaturePanel>
    </template>
  </SpoolLibraryShell>
</template>

<style scoped>
.feature-muted {
  margin: 0;
  color: var(--color-text-muted);
}
.error-line {
  margin: 0;
  color: var(--printer-error);
}
.ok-line {
  margin: 0;
  font-weight: var(--font-weight-semibold);
}
.check {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 2.75rem;
}
.check input {
  inline-size: auto;
  min-height: 0;
}
</style>
