<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  fleetCatalog,
  type EvidenceGrade,
} from '../utils/compatibility/fleet-catalog'

const grades: Record<EvidenceGrade, string> = {
  'hardware-qualified': 'Qualificado em hardware',
  documented: 'Documentado',
  'spec-derived': 'Derivado de especificação',
  unverified: 'Não verificado',
}

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
const reviewed = computed(() => {
  const term = search.value.trim().toLocaleLowerCase('pt-BR')
  return fleetCatalog.filter((item) =>
    `${item.brand} ${item.model}`.toLocaleLowerCase('pt-BR').includes(term),
  )
})
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
      <p class="count" role="status">
        {{ products.length + reviewed.length }} resultado(s)
      </p>
    </form>
    <EmptyState
      v-if="!products.length && !reviewed.length"
      title="Nenhum modelo encontrado"
      description="Nenhuma marca ou modelo combina com a busca. Tente outra busca ou veja o catálogo completo."
    >
      <Button v-if="search" @click="search = ''">Limpar busca</Button>
    </EmptyState>
    <section v-if="reviewed.length" aria-labelledby="reviewed-title">
      <h2 id="reviewed-title">Modelos revisados</h2>
      <p>
        Especificações publicadas e evidências de protocolo; não habilitam
        recursos do Connector. A qualificação em hardware do Kobra X refere-se à
        telemetria e ao firmware registrados na fonte.
      </p>
      <article
        v-for="item in reviewed"
        :key="`${item.brand}-${item.model}`"
        class="reviewed-model"
      >
        <h3>{{ item.brand }} {{ item.model }}</h3>
        <p>
          {{ item.kind === 'resin' ? 'Resina' : 'FDM' }} · Evidência do modelo:
          {{ grades[item.grade] }}
        </p>
        <p>
          Especificações:
          {{
            item.specifications === '420 × 420 × 500'
              ? '420 mm × 420 mm × 0,5 m'
              : item.specifications
          }}
        </p>
        <p v-if="item.temperatures">
          Temperaturas máximas (bico / mesa, °C): {{ item.temperatures }}
        </p>
        <p>Rede: {{ item.network }}</p>
        <p>Protocolo: {{ item.protocol }} · {{ grades[item.protocolGrade] }}</p>
        <p>Fontes:</p>
        <ul>
          <li v-for="source in item.sources" :key="source">
            <a :href="source">{{ source }}</a>
          </li>
        </ul>
      </article>
    </section>
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
.reviewed-model {
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  overflow-wrap: anywhere;
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
