<script setup lang="ts">
// A script block keeps the component loadable by the SFC test renderers.
defineOptions({ name: 'UiCard' })
</script>

<template>
  <div class="ui-card"><slot /></div>
</template>

<style scoped>
.ui-card {
  background: var(--surface-raised);
  border-radius: var(--radius-sm);
  padding: var(--space-4);
  box-shadow: var(--elevation-raised);
  min-width: 0;
}
</style>
