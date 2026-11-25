<script setup lang="ts">
// Shared frame of the members and invites lists: a labelled section with its
// heading and an optional count. Rows get the bordered panel; an empty state
// keeps its own card, so no card ends up inside another card.
defineProps<{
  headingId: string
  title: string
  summary?: string
  bordered?: boolean
}>()
</script>

<template>
  <section
    class="members-section"
    :class="{ bordered }"
    :aria-labelledby="headingId"
  >
    <header class="head">
      <h2 :id="headingId">{{ title }}</h2>
      <p v-if="summary" class="summary">{{ summary }}</p>
    </header>
    <slot />
  </section>
</template>

<style scoped>
.members-section {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--ops-space-3);
  min-width: 0;
}
.head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--ops-space-1) var(--ops-space-3);
}
h2,
.summary {
  margin: 0;
}
.summary {
  font-size: var(--ops-text-small);
  font-variant-numeric: tabular-nums;
}
</style>
