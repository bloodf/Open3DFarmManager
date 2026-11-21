<script setup lang="ts">
import { useId } from 'vue'

defineProps<{ title: string; description?: string }>()
const headingId = useId()
</script>

<template>
  <section class="feature-panel" :aria-labelledby="headingId">
    <div class="panel-head">
      <h2 :id="headingId">{{ title }}</h2>
      <p v-if="description" class="panel-description">{{ description }}</p>
    </div>
    <slot />
  </section>
</template>

<style scoped>
.feature-panel {
  display: grid;
  gap: var(--space-3);
  min-width: 0;
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
}
.panel-head {
  display: grid;
  gap: var(--space-1);
}
h2 {
  margin: 0;
  font-size: var(--font-size-lg);
}
.panel-description {
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}
.feature-panel :deep(.feature-form) {
  display: grid;
  gap: var(--space-3);
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr));
  align-items: end;
}
.feature-panel :deep(.feature-field) {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
}
.feature-panel :deep(input),
.feature-panel :deep(select),
.feature-panel :deep(textarea) {
  width: 100%;
  min-height: 2.75rem;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-text-muted);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text);
  font: inherit;
}
.feature-panel :deep(input[type='checkbox']) {
  inline-size: 1.25rem;
  block-size: 1.25rem;
  min-height: 0;
  padding: 0;
}
.feature-panel :deep(input:focus-visible),
.feature-panel :deep(select:focus-visible),
.feature-panel :deep(textarea:focus-visible),
.feature-panel :deep(a:focus-visible) {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.feature-panel :deep(.feature-error) {
  margin: 0;
  color: var(--printer-error);
}
.feature-panel :deep(.feature-muted) {
  margin: 0;
  color: var(--color-text-muted);
}
.feature-panel :deep(.feature-actions) {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: center;
}
.feature-panel :deep(.feature-link) {
  display: inline-flex;
  align-items: center;
  min-height: 2.75rem;
  padding: var(--space-2) var(--space-4);
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-sm);
  font-weight: var(--font-weight-semibold);
  text-decoration: none;
}
@media (max-width: 30rem) {
  .feature-panel {
    padding: var(--space-3);
  }
}
</style>
