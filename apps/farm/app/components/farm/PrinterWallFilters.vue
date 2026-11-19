<script setup lang="ts">
import { computed } from 'vue'
import {
  farmStateLabels,
  readFarmWallQuery,
  type FarmWallQuery,
} from '../../utils/farm-filters.ts'

defineProps<{
  total: number
  visible: number
  counts: Record<keyof typeof farmStateLabels, number>
  facets: {
    key: 'group' | 'location' | 'connector'
    label: string
    options: string[]
  }[]
}>()
const model = defineModel<FarmWallQuery>({ required: true })
function field<K extends keyof FarmWallQuery>(key: K) {
  return computed({
    get: () => model.value[key],
    set: (value: FarmWallQuery[K]) => {
      model.value = { ...model.value, [key]: value }
    },
  })
}
const query = field('query')
const filter = field('filter')
const sort = field('sort')
const alerts = field('alerts')
const groupBy = field('groupBy')
const facetModels = {
  group: field('group'),
  location: field('location'),
  connector: field('connector'),
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
  <template v-for="facet in facets" :key="facet.key">
    <label :for="`farm-${facet.key}`">{{ facet.label }}</label>
    <select :id="`farm-${facet.key}`" v-model="facetModels[facet.key].value">
      <option value="">Todos</option>
      <option v-for="option in facet.options" :key="option" :value="option">
        {{ option }}
      </option>
    </select>
  </template>
  <label for="farm-alerts">Alertas de erro</label>
  <select id="farm-alerts" v-model="alerts">
    <option value="">Todas as impressoras</option>
    <option value="yes">Com erro atual</option>
    <option value="no">Sem erro atual</option>
  </select>
  <label for="farm-group-by">Agrupar por</label>
  <select id="farm-group-by" v-model="groupBy">
    <option value="">Sem agrupamento</option>
    <option value="groupName">Grupo</option>
    <option value="location">Local</option>
  </select>
  <button type="button" @click="model = readFarmWallQuery({})">
    Limpar filtros
  </button>
  <ul class="actions" aria-label="Resumo por estado das impressoras filtradas">
    <li v-for="(label, state) in farmStateLabels" :key="state">
      {{ label }}: {{ counts[state] }}
    </li>
  </ul>
  <p role="status">{{ visible }} de {{ total }} impressoras nesta página.</p>
  <p v-if="total && !visible">
    Nenhuma impressora corresponde aos filtros. Limpe os filtros para ver todas.
  </p>
</template>

<style scoped src="./farm-view.css"></style>
