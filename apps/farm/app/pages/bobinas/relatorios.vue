<script setup lang="ts">
import { ref } from 'vue'
import Button from '../../components/ui/Button.vue'
import EmptyState from '../../components/ui/EmptyState.vue'
import ErrorState from '../../components/ui/ErrorState.vue'
import Skeleton from '../../components/ui/Skeleton.vue'
import FeaturePanel from '../../components/spool-library/FeaturePanel.vue'
import FeatureTable from '../../components/spool-library/FeatureTable.vue'
import SpoolLibraryShell from '../../components/spool-library/SpoolLibraryShell.vue'
import {
  featureFetch,
  useSpoolFeaturePage,
} from '../../composables/useSpoolFeaturePage.ts'
import {
  formatGrams,
  formatMoney,
  formatStamp,
  GROUP_BY_OPTIONS,
  inventoryReportHref,
  usageReportHref,
} from '../../utils/spool-features-format.ts'

interface InventoryGroup {
  material: string | null
  location: string | null
  spools: number
  remainingGrams: number
  remainingValue: number | null
}
interface InventoryReport {
  currency: string
  generatedAt: number
  groups: InventoryGroup[]
  lowStock: unknown[]
}

const report = ref<InventoryReport | null>(null)

async function load(farmId: string) {
  report.value = await featureFetch<InventoryReport>(
    farmId,
    'reports/inventory',
  )
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
  { id: 'material', label: 'Material' },
  { id: 'location', label: 'Localização' },
  { id: 'spools', label: 'Bobinas' },
  { id: 'grams', label: 'Restante' },
  { id: 'value', label: 'Valor restante' },
]
</script>

<template>
  <SpoolLibraryShell
    section="reports"
    title="Relatórios de bobinas"
    description="Baixe relatórios de inventário e de uso em CSV e confira o inventário atual."
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
    <FeaturePanel
      title="Downloads"
      description="Arquivos CSV gerados na hora com os dados atuais da farm."
    >
      <ul class="downloads" aria-label="Relatórios em CSV">
        <li>
          <a
            class="feature-link"
            :href="inventoryReportHref(farmId, 'groups')"
            download
          >
            Inventário (CSV)
          </a>
        </li>
        <li>
          <a
            class="feature-link"
            :href="inventoryReportHref(farmId, 'low-stock')"
            download
          >
            Estoque baixo (CSV)
          </a>
        </li>
        <li v-for="option in GROUP_BY_OPTIONS" :key="option.value">
          <a
            class="feature-link"
            :href="usageReportHref(farmId, option.value)"
            download
          >
            Uso {{ option.label.toLowerCase() }} (CSV)
          </a>
        </li>
      </ul>
    </FeaturePanel>

    <div v-if="loading" aria-busy="true">
      <p role="status">Carregando inventário…</p>
      <Skeleton />
    </div>
    <ErrorState
      v-else-if="error"
      title="Não foi possível carregar o inventário"
      :description="error"
    >
      <Button @click="page.reload">Tentar novamente</Button>
    </ErrorState>
    <FeaturePanel
      v-else-if="report"
      title="Inventário atual"
      :description="`Gerado em ${formatStamp(report.generatedAt)}.`"
    >
      <EmptyState
        v-if="!report.groups.length"
        title="Inventário vazio"
        description="Nenhuma bobina ativa cadastrada nesta farm."
      />
      <FeatureTable
        v-else
        caption="Inventário por material e localização"
        :columns="columns"
      >
        <tr v-for="(group, index) in report.groups" :key="index">
          <td>{{ group.material ?? '—' }}</td>
          <td>{{ group.location ?? '—' }}</td>
          <td>{{ group.spools }}</td>
          <td>{{ formatGrams(group.remainingGrams) }}</td>
          <td>{{ formatMoney(group.remainingValue, report.currency) }}</td>
        </tr>
      </FeatureTable>
    </FeaturePanel>
  </SpoolLibraryShell>
</template>

<style scoped>
.downloads {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}
</style>
