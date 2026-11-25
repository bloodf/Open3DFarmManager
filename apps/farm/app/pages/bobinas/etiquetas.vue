<script setup lang="ts">
import { computed, ref } from 'vue'
import Button from '../../components/ui/Button.vue'
import EmptyState from '../../components/ui/EmptyState.vue'
import ErrorState from '../../components/ui/ErrorState.vue'
import Skeleton from '../../components/ui/Skeleton.vue'
import FeaturePanel from '../../components/spool-library/FeaturePanel.vue'
import SpoolIllustration from '../../components/spool-library/SpoolIllustration.vue'
import SpoolLibraryShell from '../../components/spool-library/SpoolLibraryShell.vue'
import {
  fetchSpools,
  useSpoolFeaturePage,
} from '../../composables/useSpoolFeaturePage.ts'
import { labelsHref } from '../../utils/spool-features-format.ts'
import { spoolDisplayTitle } from '../../utils/spool-library-format.ts'
import type { SpoolItem } from '../../utils/spool-library-types.ts'

const MAX_LABELS = 100
const spools = ref<SpoolItem[]>([])
const selected = ref<number[]>([])

async function load(id: string) {
  const list = await fetchSpools(id)
  spools.value = list.items.filter((spool) => !spool.archived)
  selected.value = selected.value.filter((n) =>
    spools.value.some((spool) => spool.id === n),
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

const href = computed(() =>
  selected.value.length
    ? labelsHref(
        farmId.value,
        [...selected.value].sort((a, b) => a - b),
      )
    : '',
)
const tooMany = computed(() => selected.value.length > MAX_LABELS)
const allSelected = computed(
  () =>
    spools.value.length > 0 &&
    selected.value.length === Math.min(spools.value.length, MAX_LABELS),
)

function toggleAll() {
  selected.value = allSelected.value
    ? []
    : spools.value.slice(0, MAX_LABELS).map((spool) => spool.id)
}
</script>

<template>
  <SpoolLibraryShell
    section="labels"
    title="Etiquetas QR"
    description="Escolha as bobinas e abra a folha de etiquetas com QR code para imprimir."
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
    <EmptyState
      v-else-if="!spools.length"
      title="Nenhuma bobina ativa"
      description="Cadastre uma bobina para gerar etiquetas."
    />
    <FeaturePanel
      v-else
      title="Bobinas"
      :description="`Selecione até ${MAX_LABELS} bobinas por folha.`"
    >
      <div class="feature-actions">
        <Button @click="toggleAll">
          {{ allSelected ? 'Limpar seleção' : 'Selecionar todas' }}
        </Button>
        <a
          v-if="href && !tooMany"
          class="feature-link"
          :href="href"
          target="_blank"
          rel="noopener"
        >
          Abrir etiquetas ({{ selected.length }})
        </a>
        <span v-else class="feature-muted" role="status">
          {{
            tooMany
              ? `Selecione no máximo ${MAX_LABELS} bobinas.`
              : 'Selecione ao menos uma bobina.'
          }}
        </span>
      </div>
      <fieldset class="picker">
        <legend>Bobinas para etiquetar</legend>
        <div v-for="spool in spools" :key="spool.id" class="pick">
          <label class="pick">
            <input v-model="selected" type="checkbox" :value="spool.id" />
            <span>#{{ spool.id }} · {{ spoolDisplayTitle(spool) }}</span>
          </label>
          <SpoolIllustration :spool="spool" compact />
        </div>
      </fieldset>
    </FeaturePanel>
  </SpoolLibraryShell>
</template>

<style scoped>
.picker {
  display: grid;
  gap: var(--space-1);
  margin: 0;
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  min-width: 0;
}
.picker legend {
  padding-inline: var(--space-1);
  font-weight: var(--font-weight-semibold);
}
.pick {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 2.75rem;
  overflow-wrap: anywhere;
}
</style>
