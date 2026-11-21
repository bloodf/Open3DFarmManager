<script setup lang="ts">
// One bordered surface for a form or a section of an auth screen.
withDefaults(defineProps<{ tag?: 'form' | 'section' | 'div' }>(), {
  tag: 'div',
})
</script>

<template>
  <component :is="tag" class="auth-panel"><slot /></component>
</template>

<style scoped>
.auth-panel {
  display: grid;
  gap: var(--space-4);
  align-content: start;
  min-width: 0;
  margin: 0;
  padding: var(--space-5);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
}
.auth-panel :deep(h2),
.auth-panel :deep(h3) {
  margin: 0;
  line-height: var(--line-height-tight);
}
.auth-panel :deep(h2) {
  font-size: var(--font-size-lg);
}
.auth-panel :deep(h3) {
  font-size: var(--font-size-base);
}
.auth-panel :deep(p) {
  margin: 0;
}
@media (max-width: 30rem) {
  .auth-panel {
    padding: var(--space-4);
  }
}
</style>
