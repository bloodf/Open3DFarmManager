<script setup lang="ts">
// Plain explanatory or result message. The tone only changes the border;
// the text always says what it is, never colour alone.
withDefaults(defineProps<{ tone?: 'info' | 'warning' }>(), { tone: 'info' })
</script>

<template>
  <div class="notice" :class="tone"><slot /></div>
</template>

<style scoped>
.notice {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--color-border);
  border-inline-start-width: 0.3rem;
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  min-width: 0;
}
.notice.info {
  border-inline-start-color: var(--color-accent);
}
.notice.warning {
  border-inline-start-color: var(--state-paused-color);
}
.notice :deep(p) {
  margin: 0;
  overflow-wrap: anywhere;
}
</style>
