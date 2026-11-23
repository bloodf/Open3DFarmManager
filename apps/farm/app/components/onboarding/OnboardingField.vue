<script setup lang="ts">
// Label, control and help text with fixed ids (the callers and the page
// tests refer to them). The control comes through the default slot.
defineProps<{ id: string; label: string; help?: string }>()
</script>

<template>
  <div class="field">
    <label :for="id">{{ label }}</label>
    <slot :described-by="help ? `${id}-help` : undefined" />
    <p v-if="help" :id="`${id}-help`" class="help">{{ help }}</p>
  </div>
</template>

<style scoped>
.field {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
}
label {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
}
.help {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}
.field :deep(input:not([type='checkbox'])),
.field :deep(select) {
  width: 100%;
  min-height: 2.75rem;
  padding: var(--space-2) var(--space-3);
  font: inherit;
  color: inherit;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}
.field :deep(input:focus-visible),
.field :deep(select:focus-visible) {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.field :deep(input:disabled),
.field :deep(select:disabled) {
  opacity: 0.6;
}
</style>
