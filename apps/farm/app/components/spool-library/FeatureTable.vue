<script setup lang="ts">
import { useId } from 'vue'

defineProps<{
  caption: string
  columns: readonly { id: string; label: string }[]
}>()
const captionId = useId()
</script>

<template>
  <div
    class="feature-table-wrap"
    role="region"
    tabindex="0"
    :aria-labelledby="captionId"
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
        <slot />
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.feature-table-wrap {
  overflow-x: auto;
  max-inline-size: 100%;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}
.feature-table-wrap:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
table {
  inline-size: 100%;
  border-collapse: collapse;
  font-size: var(--font-size-sm);
}
caption {
  padding: var(--space-2) var(--space-3);
  text-align: start;
  font-weight: var(--font-weight-semibold);
}
:deep(td),
th {
  padding: var(--ops-space-1) var(--ops-space-3);
  text-align: start;
  border-top: 1px solid var(--color-border);
  vertical-align: middle;
}
th {
  white-space: nowrap;
  background: var(--ops-raised);
  color: var(--ops-text);
}
</style>
