<script setup lang="ts">
import '../assets/css/ops-screen.css'
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
  <main id="conteudo" class="compat-page ops-screen">
    <OverviewHeader
      eyebrow="Open3DFarmManager"
      title="Compatibilidade de impressoras"
      intro="Este catálogo reúne informações e limitações conhecidas. Documentação e simulação não comprovam integração ou suporte ao hardware. Os rótulos não habilitam comandos."
    />
    <p class="back chips">
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
    <section
      v-if="reviewed.length"
      class="reviewed"
      aria-labelledby="reviewed-title"
    >
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
    <div v-if="products.length" class="products">
      <CompatibilityProduct
        v-for="product in products"
        :key="product.id"
        :product="product"
        :klipper-family="klipperFamilyIds.has(product.id)"
      />
    </div>
  </main>
</template>

<style scoped>
.reviewed {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 22rem), 1fr));
  gap: var(--ops-space-3);
}
.reviewed > h2,
.reviewed > p {
  grid-column: 1 / -1;
  margin: 0;
}
.reviewed > p {
  color: var(--ops-muted);
}
.reviewed-model {
  overflow-wrap: anywhere;
}
.reviewed-model h3 {
  margin-block-end: 0;
}
.reviewed-model ul {
  margin: 0;
  padding-inline-start: var(--ops-space-5);
}
.reviewed-model a {
  display: inline-flex;
  align-items: center;
  min-block-size: 2.75rem;
}
.products {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 30rem), 1fr));
  gap: var(--ops-space-3);
  align-items: start;
}
.back,
.count {
  margin: 0;
}
.compat-page .search {
  grid-template-columns: minmax(0, 28rem);
}
.search input {
  width: 100%;
}
.count {
  font-family: var(--ops-font-mono);
  font-size: var(--ops-text-small);
  font-variant-numeric: tabular-nums;
  color: var(--ops-muted);
}
</style>
