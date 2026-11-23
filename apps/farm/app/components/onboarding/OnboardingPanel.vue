<script setup lang="ts">
// Bordered surface shared by the forms and lists of the onboarding screens.
// An optional heading labels the region for assistive technology.
defineProps<{
  headingId?: string
  title?: string
  summary?: string
  busy?: boolean
}>()
</script>

<template>
  <section
    class="panel"
    :aria-labelledby="title ? headingId : undefined"
    :aria-busy="busy ? 'true' : undefined"
  >
    <header v-if="title" class="head">
      <h2 :id="headingId">{{ title }}</h2>
      <p v-if="summary" class="summary">{{ summary }}</p>
    </header>
    <slot />
  </section>
</template>

<style scoped>
.panel {
  display: grid;
  gap: var(--space-3);
  margin: 0;
  padding: var(--space-5);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  min-width: 0;
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
  overflow-wrap: anywhere;
}
.summary {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}
.panel :deep(p) {
  margin: 0;
}
/* Empty and error cards share the panel surface: no card inside a card. */
.panel :deep(.ui-card) {
  border: 1px solid var(--color-border);
  box-shadow: none;
}
@media (max-width: 30rem) {
  .panel {
    padding: var(--space-4);
  }
}
</style>
