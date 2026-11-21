<script setup lang="ts">
// Polite live region for progress and success messages. Empty, it takes no space.
defineProps<{ message: string; tone?: 'success' }>()
</script>

<template>
  <p
    class="auth-status"
    :class="{ filled: message, success: tone === 'success' }"
    role="status"
  >
    {{ message }}
  </p>
</template>

<style scoped>
.auth-status {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  overflow-wrap: anywhere;
}
.auth-status:not(.filled) {
  display: none;
}
.auth-status.success {
  padding: var(--space-3);
  border: 1px solid var(--state-idle-color);
  border-inline-start-width: var(--space-1);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-base);
  color: var(--color-text);
}
</style>
