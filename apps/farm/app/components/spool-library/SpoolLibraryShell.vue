<script setup lang="ts">
import { computed } from 'vue'
import Button from '../ui/Button.vue'
import EmptyState from '../ui/EmptyState.vue'
import ErrorState from '../ui/ErrorState.vue'
import Skeleton from '../ui/Skeleton.vue'
import Toast from '../ui/Toast.vue'
import type { FarmSummary } from '../../composables/useSpoolLibraryFarm.ts'

const props = defineProps<{
  section:
    | 'spools'
    | 'filaments'
    | 'vendors'
    | 'import'
    | 'slots'
    | 'usage'
    | 'stock'
    | 'drying'
    | 'labels'
    | 'finder'
    | 'reports'
  title: string
  description: string
  farms: readonly FarmSummary[]
  farmId: string
  loading: boolean
  loadError: string
  signInRequired: boolean
  noFarm: boolean
  canImport?: boolean
  statusMessage?: string
}>()

const emit = defineEmits<{
  retry: []
  selectFarm: [farmId: string]
}>()

const navLinks = computed(() => {
  const query = props.farmId ? { farm: props.farmId } : undefined
  return [
    {
      id: 'spools' as const,
      to: { path: '/bobinas', query },
      label: 'Bobinas',
    },
    {
      id: 'filaments' as const,
      to: { path: '/bobinas/filamentos', query },
      label: 'Filamentos',
    },
    {
      id: 'vendors' as const,
      to: { path: '/bobinas/fornecedores', query },
      label: 'Fornecedores',
    },
    {
      id: 'import' as const,
      to: { path: '/bobinas/importar', query },
      label: 'Importar',
    },
    {
      id: 'slots' as const,
      to: { path: '/bobinas/slots', query },
      label: 'Slots',
    },
    {
      id: 'usage' as const,
      to: { path: '/bobinas/uso', query },
      label: 'Uso e custo',
    },
    {
      id: 'stock' as const,
      to: { path: '/bobinas/estoque', query },
      label: 'Estoque baixo',
    },
    {
      id: 'drying' as const,
      to: { path: '/bobinas/secagem', query },
      label: 'Secagem e umidade',
    },
    {
      id: 'labels' as const,
      to: { path: '/bobinas/etiquetas', query },
      label: 'Etiquetas',
    },
    {
      id: 'finder' as const,
      to: { path: '/bobinas/localizar', query },
      label: 'Localizar',
    },
    {
      id: 'reports' as const,
      to: { path: '/bobinas/relatorios', query },
      label: 'Relatórios',
    },
  ]
})

function onFarmChange(event: Event) {
  const select = event.currentTarget
  if (select instanceof HTMLSelectElement && select.value) {
    emit('selectFarm', select.value)
  }
}
</script>

<template>
  <main class="spool-library-page">
    <header class="page-header">
      <div class="header-top">
        <div class="header-copy">
          <h1>{{ title }}</h1>
          <p class="intro">{{ description }}</p>
        </div>
        <div class="header-meta">
          <label v-if="farms.length > 1" class="farm-picker">
            <span>Farm</span>
            <select :value="farmId" @change="onFarmChange">
              <option
                v-for="farm in farms"
                :key="farm.farmId"
                :value="farm.farmId"
              >
                {{ farm.farmId }}
              </option>
            </select>
          </label>
          <NuxtLink v-if="canImport" to="/spoolman" class="external-link">
            Configurar Spoolman externo
          </NuxtLink>
        </div>
      </div>

      <nav class="subnav" aria-label="Seções da biblioteca de bobinas">
        <NuxtLink
          v-for="link in navLinks"
          :key="link.id"
          :to="link.to"
          class="subnav-link"
          :aria-current="section === link.id ? 'page' : undefined"
        >
          {{ link.label }}
        </NuxtLink>
      </nav>
    </header>

    <Toast :message="statusMessage ?? ''" />

    <div v-if="loading" aria-busy="true" class="panel loading">
      <p role="status">Carregando a biblioteca de bobinas…</p>
      <Skeleton />
      <Skeleton />
      <Skeleton />
    </div>

    <div v-else-if="loadError" role="alert" class="panel error-panel">
      <ErrorState
        title="Biblioteca de bobinas indisponível"
        :description="loadError"
      >
        <div class="actions">
          <Button @click="emit('retry')">Tentar novamente</Button>
          <NuxtLink v-if="signInRequired" to="/entrar" class="cta">
            Entrar
          </NuxtLink>
        </div>
      </ErrorState>
    </div>

    <EmptyState
      v-else-if="noFarm"
      title="Nenhuma farm disponível"
      description="Esta conta ainda não tem uma farm para gerenciar bobinas. Crie uma farm ou peça acesso."
    >
      <NuxtLink to="/farm" class="cta">Ir para farms</NuxtLink>
    </EmptyState>

    <template v-else-if="farmId">
      <slot />
    </template>
  </main>
</template>

<style scoped>
.spool-library-page {
  display: grid;
  gap: var(--space-4);
  align-content: start;
  min-width: 0;
}
.page-header {
  display: grid;
  gap: var(--space-3);
  min-width: 0;
}
.header-top {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--space-3);
}
.header-copy {
  display: grid;
  gap: var(--space-2);
  min-width: 0;
}
.header-copy h1 {
  margin: 0;
  overflow-wrap: anywhere;
}
.intro {
  margin: 0;
  color: var(--color-text-muted);
}
.header-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}
.farm-picker {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  font-weight: var(--font-weight-semibold);
}
.farm-picker select {
  min-height: 2.75rem;
  max-inline-size: 100%;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-text-muted);
  border-radius: var(--radius-sm);
  background: var(--color-surface-raised);
  color: var(--color-text);
  font: inherit;
}
.external-link {
  display: inline-flex;
  align-items: center;
  min-height: 2.75rem;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
}
.subnav {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding-bottom: var(--space-2);
  border-bottom: 1px solid var(--color-border);
}
.subnav-link {
  display: inline-flex;
  align-items: center;
  min-height: 2.75rem;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface-raised);
  color: var(--color-text);
  text-decoration: none;
  font-weight: var(--font-weight-semibold);
}
.subnav-link[aria-current='page'] {
  border-color: var(--color-accent);
  background: var(--color-accent);
  color: var(--color-on-accent);
}
.subnav-link:focus-visible,
.cta:focus-visible,
.farm-picker select:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.panel {
  display: grid;
  gap: var(--space-3);
  min-width: 0;
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
}
.loading :deep(.skeleton) {
  min-block-size: var(--space-5);
}
.error-panel :deep(.ui-card) {
  padding: 0;
  box-shadow: none;
  background: transparent;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: center;
  margin-top: var(--space-2);
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
  .panel {
    padding: var(--space-3);
  }
}
</style>
