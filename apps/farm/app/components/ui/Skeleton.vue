<script setup lang="ts">
// A script block keeps the component loadable by the SFC test renderers.
defineOptions({ name: 'UiSkeleton' })
</script>

<template>
  <div class="skeleton" aria-hidden="true"></div>
</template>

<style scoped>
.skeleton {
  min-block-size: var(--space-4);
  border-radius: var(--radius-sm);
  background: var(--text-muted);
  opacity: 0.25;
}
</style>
