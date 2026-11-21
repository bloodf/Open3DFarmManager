<script setup lang="ts">
// A bordered settings section named by its own h2.
defineProps<{
  headingId: string
  title: string
  /** Marks the section busy while its content loads or saves. */
  busy?: boolean
}>()
</script>

<template>
  <section
    class="settings-panel"
    :aria-labelledby="headingId"
    :aria-busy="busy"
  >
    <h2 :id="headingId">{{ title }}</h2>
    <p v-if="$slots.description" class="description">
      <slot name="description" />
    </p>
    <slot />
  </section>
</template>

<style scoped>
.settings-panel {
  display: grid;
  gap: var(--space-3);
  margin: 0;
  padding: var(--space-5);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  min-width: 0;
}
h2 {
  margin: 0;
  font-size: var(--font-size-lg);
  line-height: var(--line-height-tight);
  overflow-wrap: anywhere;
}
.description {
  margin: 0;
  color: var(--color-text-muted);
}
.settings-panel :deep(p) {
  margin-block: 0;
}
.settings-panel :deep(code) {
  overflow-wrap: anywhere;
  word-break: break-all;
}
@media (max-width: 30rem) {
  .settings-panel {
    padding: var(--space-4);
  }
}
</style>
