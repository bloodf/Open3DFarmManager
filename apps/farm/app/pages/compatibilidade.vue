<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  capabilityLabels,
  capabilityStatusLabels,
  filterCompatibility,
} from '../utils/compatibility/index'

const search = ref('')
const products = computed(() => filterCompatibility(search.value))
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
    <p v-if="!products.length">Nenhum modelo encontrado. Tente outra busca.</p>
    <section
      v-for="product in products"
      :key="product.id"
      :aria-labelledby="product.id"
    >
      <h2 :id="product.id">{{ product.brand }} {{ product.model }}</h2>
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
