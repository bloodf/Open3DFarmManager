<script setup lang="ts">
import { computed, ref } from 'vue'
import Button from '../components/ui/Button.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import {
  capabilityLabels,
  capabilityStatusLabels,
  compatibilityPageCatalog,
  controlAreaKeys,
  controlAreaLabels,
  filterCompatibility,
  klipperFamilyIds,
} from '../utils/compatibility/index'

const search = ref('')
const products = computed(() =>
  filterCompatibility(search.value, compatibilityPageCatalog),
)
</script>

<template>
  <main>
    <h1>Compatibilidade de impressoras</h1>
    <p>
      Este catálogo reúne informações e limitações conhecidas. Documentação e
      simulação não comprovam integração ou suporte ao hardware. Os rótulos não
      habilitam comandos.
    </p>
    <label for="compat-search">Buscar marca ou modelo</label>
    <input
      id="compat-search"
      v-model="search"
      type="search"
      autocomplete="off"
    />
    <p role="status">{{ products.length }} resultado(s)</p>
    <EmptyState
      v-if="!products.length"
      title="Nenhum modelo encontrado"
      description="Nenhuma marca ou modelo combina com a busca. Tente outra busca ou veja o catálogo completo."
    >
      <Button v-if="search" @click="search = ''">Limpar busca</Button>
    </EmptyState>
    <section
      v-for="product in products"
      :key="product.id"
      :aria-labelledby="product.id"
    >
      <h2 :id="product.id">{{ product.brand }} {{ product.model }}</h2>
      <p v-if="klipperFamilyIds.has(product.id)">
        Família Klipper/Moonraker. Simulado indica teste contra simuladores, não
        contra hardware.
      </p>
      <dl>
        <dt>Lançamento</dt>
        <dd>
          {{ product.releaseStatus
          }}<span v-if="product.releaseDate"> ({{ product.releaseDate }})</span>
        </dd>
        <dt>Firmware</dt>
        <dd>{{ product.firmwareStatus }}</dd>
        <dt>Conexão</dt>
        <dd>{{ product.connection }}</dd>
        <template
          v-for="(status, capability) in product.capabilities"
          :key="capability"
        >
          <dt>{{ capabilityLabels[capability] }}</dt>
          <dd>{{ capabilityStatusLabels[status] }}</dd>
        </template>
      </dl>
      <h3>Áreas de controle</h3>
      <dl>
        <template v-for="area in controlAreaKeys" :key="area">
          <dt>{{ controlAreaLabels[area] }}</dt>
          <dd>{{ capabilityStatusLabels[product.controlAreas[area]] }}</dd>
        </template>
      </dl>
      <template v-if="product.firmwareNotes?.length">
        <h3>Notas de firmware</h3>
        <ul>
          <li v-for="(entry, index) in product.firmwareNotes" :key="index">
            {{ entry.firmware }}: {{ entry.note }}
          </li>
        </ul>
      </template>
      <h3>Limitações</h3>
      <ul>
        <li v-for="limit in product.limitations" :key="limit">{{ limit }}</li>
      </ul>
      <h3>Fontes</h3>
      <ul>
        <li v-for="(source, index) in product.sources" :key="source">
          <a :href="source">Fonte {{ index + 1 }} para {{ product.model }}</a>
        </li>
      </ul>
    </section>
    <NuxtLink to="/impressoras">Voltar para impressoras</NuxtLink>
  </main>
</template>

<style scoped>
main {
  max-width: 58rem;
  margin: 2rem auto;
  padding: 0 1rem;
  line-height: 1.6;
}
label,
input {
  display: block;
  margin-block: 0.6rem;
}
input {
  font: inherit;
  width: 100%;
  max-width: 100%;
  min-height: 2.75rem;
  padding: 0.5rem;
  box-sizing: border-box;
}
section {
  margin-block: 2rem;
  border: 1px solid currentColor;
  padding: 1rem;
}
p,
li,
dd {
  overflow-wrap: anywhere;
}
:focus-visible {
  outline: 3px solid #155e75;
  outline-offset: 3px;
}
</style>
