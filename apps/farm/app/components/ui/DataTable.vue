<script setup lang="ts">
import { useId } from 'vue'

defineProps<{
  caption: string
  columns: readonly { id: string; label: string }[]
  rows: readonly {
    id: string
    cells: Readonly<Record<string, string | number>>
  }[]
}>()
const captionId = useId()
</script>

<template>
  <div
    class="table-scroll"
    role="region"
    :aria-labelledby="captionId"
    tabindex="0"
  >
    <table>
      <caption :id="captionId">
        {{
          caption
        }}
      </caption>
      <thead>
        <tr>
          <th v-for="column in columns" :key="column.id" scope="col">
            {{ column.label }}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.id">
          <td v-for="column in columns" :key="column.id">
            <slot :name="column.id" :row="row">{{ row.cells[column.id] }}</slot>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length">Nenhum resultado.</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.table-scroll {
  overflow: auto;
  max-inline-size: 100%;
}
.table-scroll:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-offset-compact);
}
table {
  border-collapse: collapse;
  width: 100%;
}
caption {
  text-align: start;
  font-weight: 600;
}
th,
td {
  text-align: start;
  padding: var(--space-2);
  border-block-end: 1px solid var(--text-muted);
}
</style>
