<script setup lang="ts">
import { computed, ref } from 'vue'
import CompatibilityProduct from '../components/overview/CompatibilityProduct.vue'
import OverviewHeader from '../components/overview/OverviewHeader.vue'
import Button from '../components/ui/Button.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import {
  compatibilityPageCatalog,
  filterCompatibility,
  klipperFamilyIds,
} from '../utils/compatibility/index'

const search = ref('')
const products = computed(() =>
  filterCompatibility(search.value, compatibilityPageCatalog),
)
</script>

<template>
  <main id="conteudo" class="compat-page">
    <OverviewHeader
      eyebrow="Open3DFarmManager"
      title="Compatibilidade de impressoras"
      intro="Este catálogo reúne informações e limitações conhecidas. Documentação e simulação não comprovam integração ou suporte ao hardware. Os rótulos não habilitam comandos."
    />
    <p class="back">
      <NuxtLink to="/impressoras">Voltar para impressoras</NuxtLink>
    </p>
    <form
      class="search"
      role="search"
      aria-label="Buscar no catálogo"
      @submit.prevent
    >
      <label for="compat-search">Buscar marca ou modelo</label>
      <input
        id="compat-search"
        v-model="search"
        type="search"
        autocomplete="off"
      />
      <p class="count" role="status">{{ products.length }} resultado(s)</p>
    </form>
    <EmptyState
      v-if="!products.length"
      title="Nenhum modelo encontrado"
      description="Nenhuma marca ou modelo combina com a busca. Tente outra busca ou veja o catálogo completo."
    >
      <Button v-if="search" @click="search = ''">Limpar busca</Button>
    </EmptyState>
    <CompatibilityProduct
      v-for="product in products"
      :key="product.id"
      :product="product"
      :klipper-family="klipperFamilyIds.has(product.id)"
    />
  </main>
</template>

<style scoped>
.compat-page {
  display: grid;
  gap: var(--space-4);
  align-content: start;
}
.back,
.count {
  margin: 0;
}
.search {
  display: grid;
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-5);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
}
label {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
}
input {
  width: 100%;
  min-height: 2.75rem;
  padding: var(--space-2) var(--space-3);
  font: inherit;
  color: inherit;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}
input:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.count {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}
a:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
/* Same bordered surface as the search and product panels. */
.compat-page :deep(.ui-card) {
  border: 1px solid var(--color-border);
  box-shadow: none;
}
@media (max-width: 30rem) {
  .search {
    padding: var(--space-4);
  }
}
</style>
