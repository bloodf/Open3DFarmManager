<script setup lang="ts">
withDefaults(defineProps<{ type?: 'button' | 'submit' | 'reset' }>(), {
  type: 'button',
})
</script>

<template>
  <button :type="type" class="ui-button"><slot /></button>
</template>

<style scoped>
.ui-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 2.75rem;
  min-width: 2.75rem;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  background: var(--surface-raised);
  color: var(--accent);
  font: inherit;
  cursor: pointer;
}
.ui-button:disabled {
  opacity: 0.6;
  cursor: default;
}
.ui-button:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-offset-compact);
}
</style>
