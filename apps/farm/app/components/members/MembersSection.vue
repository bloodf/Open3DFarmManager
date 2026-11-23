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
  gap: var(--space-3);
  min-width: 0;
}
.members-section.bordered {
  padding: var(--space-5);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
}
.head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-1) var(--space-3);
}
h2 {
  margin: 0;
  font-size: var(--font-size-lg);
  line-height: var(--line-height-tight);
}
.summary {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}
/* The empty-state card shares the bordered surface of the filled panel. */
.members-section :deep(.ui-card) {
  border: 1px solid var(--color-border);
  box-shadow: none;
}
@media (max-width: 30rem) {
  .members-section.bordered {
    padding: var(--space-4);
  }
}
</style>
