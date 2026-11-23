<script setup lang="ts">
// A script block keeps the component loadable by the SFC test renderers.
defineOptions({ name: 'UiCard' })
</script>

<template>
  <div class="ui-card"><slot /></div>
</template>

<style scoped>
.ui-card {
  background: var(--ops-panel);
  border-radius: var(--ops-radius-md);
  padding: var(--ops-space-4);
  border: 1px solid var(--ops-border);
  color: var(--ops-text);
  min-width: 0;
}
</style>
