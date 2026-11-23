<script setup lang="ts">
defineProps<{ message: string }>()
</script>

<template>
  <div role="status" aria-live="polite" aria-atomic="true">
    <p v-if="message" class="toast">{{ message }}</p>
  </div>
</template>

<style scoped>
.toast {
  background: var(--surface-raised);
  border-inline-start: 3px solid var(--accent);
  padding: var(--space-2) var(--space-3);
}
</style>
