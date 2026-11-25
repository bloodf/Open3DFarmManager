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
  gap: var(--ops-space-4);
  align-content: start;
  min-width: 0;
  margin: 0;
  padding: var(--ops-space-4);
  border: 1px solid var(--ops-border);
  border-radius: var(--ops-radius-lg);
  background: var(--ops-panel);
  color: var(--ops-text);
}
.auth-panel :deep(h2),
.auth-panel :deep(h3) {
  margin: 0;
  padding-block-end: var(--ops-space-2);
  border-block-end: 1px solid var(--ops-border);
  font-size: var(--ops-text-body);
  line-height: 20px;
}
.auth-panel :deep(p) {
  margin: 0;
}
</style>
