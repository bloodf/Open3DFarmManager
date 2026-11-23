<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Button from '../../components/ui/Button.vue'
import ErrorState from '../../components/ui/ErrorState.vue'
import Skeleton from '../../components/ui/Skeleton.vue'
import SpoolImportPanel from '../../components/spool-library/SpoolImportPanel.vue'
import SpoolLibraryShell from '../../components/spool-library/SpoolLibraryShell.vue'
import { useSpoolLibraryFarm } from '../../composables/useSpoolLibraryFarm.ts'
import { extractApiError } from '../../utils/spool-library-format.ts'
import type {
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

const canImport = ref(false)
const checkingAccess = ref(false)
const accessError = ref('')
let accessController: AbortController | undefined

async function loadAccess() {
  if (!farmId.value) return
  accessController?.abort()
  const signal = (accessController = new AbortController()).signal
  checkingAccess.value = true
  accessError.value = ''
  try {
    const response = await $fetch<SpoolLibraryListResponse<VendorItem>>(
      `/api/farms/${farmId.value}/spool-library/vendors`,
      { query: { limit: 1 }, retry: 0, timeout: 15_000, signal },
    )
    canImport.value = response.canImport
  } catch (cause) {
    if (signal.aborted) return
    accessError.value = extractApiError(
      cause,
      'Não foi possível verificar as permissões de importação.',
    ).message
  } finally {
    if (!signal.aborted) checkingAccess.value = false
  }
}

async function retryLoad() {
  await loadFarms()
  if (farmId.value) await loadAccess()
}

onMounted(async () => {
  await loadFarms()
  if (farmId.value) await loadAccess()
})

watch(farmId, (next, prev) => {
  if (next && next !== prev) void loadAccess()
})

onBeforeUnmount(() => {
  accessController?.abort()
})
</script>

<template>
  <SpoolLibraryShell
    section="import"
    title="Importar biblioteca de bobinas"
    description="Traga fornecedores, filamentos e bobinas a partir da API do Spoolman ou de arquivos JSON e CSV com simulação e relatório detalhado."
    :farms="farms"
    :farm-id="farmId"
    :loading="loadingFarm"
    :load-error="farmLoadError"
    :sign-in-required="signInRequired"
    :no-farm="noFarm"
    :can-import="canImport"
    @retry="retryLoad"
    @select-farm="selectFarm"
  >
    <div v-if="checkingAccess" aria-busy="true" class="panel loading">
      <p role="status">Verificando permissões de importação…</p>
      <Skeleton />
    </div>

    <ErrorState
      v-else-if="accessError"
      title="Não foi possível carregar a importação"
      :description="accessError"
    >
      <Button @click="loadAccess">Tentar novamente</Button>
    </ErrorState>

    <SpoolImportPanel v-else :farm-id="farmId" :can-import="canImport" />
  </SpoolLibraryShell>
</template>

<style scoped>
.panel {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
}
.loading :deep(.skeleton) {
  min-block-size: var(--space-5);
}
</style>
