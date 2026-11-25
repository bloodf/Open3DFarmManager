<script setup lang="ts">
import Icon from '../ui/Icon.vue'

// Polite live region for progress and success messages. Empty, it takes no space.
defineProps<{ message: string; tone?: 'success' }>()
</script>

<template>
  <p
    class="auth-status"
    :class="{ filled: message, success: tone === 'success' }"
    role="status"
  >
    <Icon v-if="tone === 'success' && message" name="check" />
    <span>{{ message }}</span>
  </p>
</template>

<style scoped>
.auth-status {
  margin: 0;
  font-size: var(--ops-text-small);
  line-height: 18px;
  color: var(--ops-muted);
  overflow-wrap: anywhere;
}
.auth-status:not(.filled) {
  display: none;
}
.auth-status.success {
  display: flex;
  align-items: flex-start;
  gap: var(--ops-space-2);
  padding: var(--ops-space-2) var(--ops-space-3);
  border-inline-start: 3px solid var(--ops-action);
  border-radius: var(--ops-radius-sm);
  background: var(--ops-raised);
  font-size: var(--ops-text-body);
  line-height: 20px;
  color: var(--ops-text);
}
.auth-status svg {
  flex: none;
  color: var(--ops-action);
}
</style>
