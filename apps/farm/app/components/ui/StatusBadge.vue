<script setup lang="ts">
defineProps<{
  tone: 'idle' | 'printing' | 'paused' | 'error' | 'offline' | 'stale'
  label: string
}>()
</script>

<template>
  <span class="badge" :style="{ color: `var(--printer-${tone})` }">{{
    label
  }}</span>
</template>

<style scoped>
.badge {
  display: inline-block;
  border: 1px solid currentColor;
  border-radius: var(--radius-sm);
  padding: var(--space-1) var(--space-2);
  font-size: var(--type-small);
  font-weight: 600;
}
</style>
