<script setup lang="ts">
import { type FarmFilter, type FarmSort } from '../../utils/farm-filters.ts'
defineProps<{ total: number; visible: number }>()
const query = defineModel<string>('query', { required: true })
const filter = defineModel<FarmFilter>('filter', { required: true })
const sort = defineModel<FarmSort>('sort', { required: true })
function resetFilters() {
  query.value = ''
  filter.value = 'all'
  sort.value = 'original'
}
</script>

<template>
  <label for="farm-search">Buscar impressora, Connector ou atribuição</label>
  <input id="farm-search" v-model="query" type="search" />
  <label for="farm-filter">Filtrar por estado ou conexão</label>
  <select id="farm-filter" v-model="filter">
    <option value="all">Todos</option>
    <option value="printing">Imprimindo</option>
    <option value="idle">Ociosa</option>
    <option value="paused">Pausada</option>
    <option value="error">Erro</option>
    <option value="offline">Indisponível segundo o Connector</option>
    <option value="unknown">Sem estado recebido</option>
    <option value="stale">Observação não atual</option>
    <option value="connected">Conexão autenticada</option>
    <option value="disconnected">Sem conexão autenticada</option>
  </select>
  <label for="farm-sort">Ordenar</label>
  <select id="farm-sort" v-model="sort">
    <option value="original">Ordem original</option>
    <option value="name-asc">Nome crescente</option>
    <option value="name-desc">Nome decrescente</option>
  </select>
  <button type="button" @click="resetFilters">Limpar filtros</button>
  <p role="status">{{ visible }} de {{ total }} impressoras nesta página.</p>
  <p v-if="total && !visible">
    Nenhuma impressora corresponde aos filtros. Limpe os filtros para ver todas.
  </p>
</template>

<style scoped src="./farm-view.css"></style>
