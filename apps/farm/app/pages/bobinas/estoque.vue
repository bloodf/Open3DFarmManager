<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import Button from '../../components/ui/Button.vue'
import EmptyState from '../../components/ui/EmptyState.vue'
import ErrorState from '../../components/ui/ErrorState.vue'
import Skeleton from '../../components/ui/Skeleton.vue'
import StatusBadge from '../../components/ui/StatusBadge.vue'
import FeaturePanel from '../../components/spool-library/FeaturePanel.vue'
import FeatureTable from '../../components/spool-library/FeatureTable.vue'
import SpoolLibraryShell from '../../components/spool-library/SpoolLibraryShell.vue'
import {
  featureFetch,
  fetchSpools,
  useSpoolFeaturePage,
} from '../../composables/useSpoolFeaturePage.ts'
import {
  formatGrams,
  inventoryReportHref,
  parseThreshold,
} from '../../utils/spool-features-format.ts'
import type {
  LowStockItem,
  LowStockResponse,
} from '../../utils/spool-features-types.ts'

const stock = ref<LowStockResponse | null>(null)
const canWrite = ref(false)
const busy = ref(false)
const defaultInput = ref('')
const defaultError = ref('')
const drafts = reactive<Record<number, string>>({})
const rowErrors = reactive<Record<number, string>>({})

async function load(farmId: string) {
  const [response, spools] = await Promise.all([
    featureFetch<LowStockResponse>(farmId, 'low-stock'),
    fetchSpools(farmId),
  ])
  stock.value = response
  canWrite.value = spools.canWrite
  defaultInput.value =
    response.defaultLowStockThresholdGrams === null
      ? ''
      : String(response.defaultLowStockThresholdGrams)
  for (const item of response.filaments)
    drafts[item.filamentId] =
      item.thresholdGrams === null ? '' : String(item.thresholdGrams)
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
  actionError,
  selectFarm,
} = page

const lowItems = computed(
  () => stock.value?.filaments.filter((item) => item.low) ?? [],
)
const columns = [
  { id: 'filament', label: 'Filamento' },
  { id: 'remaining', label: 'Restante' },
  { id: 'threshold', label: 'Limite efetivo' },
  { id: 'status', label: 'Situação' },
  { id: 'custom', label: 'Limite do filamento (g)' },
  { id: 'action', label: 'Ações' },
]

function itemName(item: LowStockItem): string {
  return [item.name ?? `Filamento #${item.filamentId}`, item.material]
    .filter(Boolean)
    .join(' · ')
}

async function saveDefault() {
  const parsed = parseThreshold(defaultInput.value)
  if (!parsed.ok) {
    defaultError.value = parsed.error
    return
  }
  defaultError.value = ''
  if (busy.value) return
  busy.value = true
  await page.act(
    async () => {
      await featureFetch(farmId.value, 'low-stock/settings', {
        method: 'PUT',
        body: { defaultLowStockThresholdGrams: parsed.value },
      })
      await load(farmId.value)
    },
    parsed.value === null
      ? 'Limite padrão removido.'
      : `Limite padrão definido em ${formatGrams(parsed.value)}.`,
    'Não foi possível salvar o limite padrão (apenas proprietários e administradores).',
  )
  busy.value = false
}

async function saveThreshold(item: LowStockItem) {
  const parsed = parseThreshold(drafts[item.filamentId] ?? '')
  if (!parsed.ok) {
    rowErrors[item.filamentId] = parsed.error
    return
  }
  rowErrors[item.filamentId] = ''
  if (busy.value) return
  busy.value = true
  await page.act(
    async () => {
      await featureFetch(
        farmId.value,
        `low-stock/filaments/${item.filamentId}`,
        { method: 'PUT', body: { thresholdGrams: parsed.value } },
      )
      await load(farmId.value)
    },
    parsed.value === null
      ? `${itemName(item)} voltou a usar o limite padrão.`
      : `Limite de ${itemName(item)} definido em ${formatGrams(parsed.value)}.`,
    'Não foi possível salvar o limite do filamento (apenas proprietários e administradores).',
  )
  busy.value = false
}
</script>

<template>
  <SpoolLibraryShell
    section="stock"
    title="Estoque baixo"
    description="Filamentos com pouco material restante e os limites que disparam o alerta."
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
    <p v-if="actionError" role="alert" class="error-line">{{ actionError }}</p>

    <div v-if="loading" aria-busy="true">
      <p role="status">Carregando estoque…</p>
      <Skeleton />
    </div>
    <ErrorState
      v-else-if="error"
      title="Não foi possível carregar o estoque"
      :description="error"
    >
      <Button @click="page.reload">Tentar novamente</Button>
    </ErrorState>
    <template v-else-if="stock">
      <FeaturePanel
        title="Alertas"
        description="Filamentos cujo restante está no limite ou abaixo dele."
      >
        <p v-if="lowItems.length" role="status" class="alert-line">
          {{ lowItems.length }} filamento(s) com estoque baixo.
        </p>
        <p v-else role="status" class="feature-muted">
          Nenhum filamento com estoque baixo.
        </p>
        <ul v-if="lowItems.length" class="low-list" aria-label="Estoque baixo">
          <li v-for="item in lowItems" :key="item.filamentId">
            <span>
              <strong>{{ itemName(item) }}</strong>
              — restam {{ formatGrams(item.remainingGrams) }} (limite
              {{ formatGrams(item.effectiveThresholdGrams) }})
            </span>
            <NuxtLink
              class="feature-link"
              :to="{ path: '/bobinas/filamentos', query: { farm: farmId } }"
              :aria-label="`Repor ${itemName(item)}`"
            >
              Repor
            </NuxtLink>
          </li>
        </ul>
        <div class="feature-actions">
          <a
            class="feature-link"
            :href="inventoryReportHref(farmId, 'low-stock')"
            download
          >
            Baixar CSV de estoque baixo
          </a>
        </div>
      </FeaturePanel>

      <FeaturePanel
        title="Limite padrão da farm"
        description="Usado quando o filamento não tem limite próprio. Deixe vazio para desativar."
      >
        <form
          v-if="canWrite"
          class="feature-form"
          @submit.prevent="saveDefault"
        >
          <label class="feature-field">
            Limite padrão (g)
            <input
              v-model="defaultInput"
              type="text"
              inputmode="decimal"
              placeholder="Ex.: 200"
              :aria-invalid="defaultError ? true : undefined"
            />
          </label>
          <Button type="submit" :disabled="busy">Salvar limite padrão</Button>
        </form>
        <p v-if="defaultError" role="alert" class="error-line">
          {{ defaultError }}
        </p>
        <p v-if="!canWrite" class="feature-muted">
          Limite padrão:
          {{ formatGrams(stock.defaultLowStockThresholdGrams) }}. Somente
          leitura.
        </p>
      </FeaturePanel>

      <FeaturePanel
        title="Limites por filamento"
        description="Defina um limite próprio ou deixe vazio para usar o padrão."
      >
        <EmptyState
          v-if="!stock.filaments.length"
          title="Nenhum filamento cadastrado"
          description="Cadastre filamentos e bobinas para acompanhar o estoque."
        />
        <FeatureTable v-else caption="Estoque por filamento" :columns="columns">
          <tr v-for="item in stock.filaments" :key="item.filamentId">
            <td>{{ itemName(item) }}</td>
            <td>{{ formatGrams(item.remainingGrams) }}</td>
            <td>{{ formatGrams(item.effectiveThresholdGrams) }}</td>
            <td>
              <StatusBadge
                :tone="item.low ? 'error' : 'idle'"
                :label="item.low ? 'Baixo' : 'OK'"
              />
            </td>
            <td>
              <input
                v-if="canWrite"
                v-model="drafts[item.filamentId]"
                type="text"
                inputmode="decimal"
                class="cell-input"
                :aria-label="`Limite em gramas para ${itemName(item)}`"
                :aria-invalid="rowErrors[item.filamentId] ? true : undefined"
              />
              <template v-else>{{ formatGrams(item.thresholdGrams) }}</template>
              <span
                v-if="rowErrors[item.filamentId]"
                role="alert"
                class="error-line"
              >
                {{ rowErrors[item.filamentId] }}
              </span>
            </td>
            <td>
              <Button
                v-if="canWrite"
                :disabled="busy"
                :aria-label="`Salvar limite de ${itemName(item)}`"
                @click="saveThreshold(item)"
              >
                Salvar
              </Button>
            </td>
          </tr>
        </FeatureTable>
      </FeaturePanel>
    </template>
  </SpoolLibraryShell>
</template>

<style scoped>
.error-line {
  margin: 0;
  color: var(--printer-error);
}
.alert-line {
  margin: 0;
  font-weight: var(--font-weight-semibold);
}
.low-list {
  display: grid;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}
.low-list li {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-inline-start: var(--space-1) solid var(--printer-error);
  border-radius: var(--radius-sm);
}
.cell-input {
  inline-size: 8rem;
  min-height: 2.75rem;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-text-muted);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text);
  font: inherit;
}
.cell-input:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
</style>
