<script setup lang="ts">
import { ref } from 'vue'

// Always in the page so a screen reader announces the message when it appears.
// Empty, it takes no space. The page moves focus here after a failure.
defineProps<{ message: string }>()
const root = ref<HTMLElement | null>(null)
defineExpose({ focus: () => root.value?.focus() })
</script>

<template>
  <p
    ref="root"
    class="auth-alert"
    :class="{ filled: message }"
    role="alert"
    tabindex="-1"
  >
    {{ message }}
  </p>
</template>

<style scoped>
.auth-alert {
  margin: 0;
}
.auth-alert:not(.filled) {
  display: none;
}
.auth-alert.filled {
  padding: var(--space-3);
  border: 1px solid var(--printer-error);
  border-inline-start-width: var(--space-1);
  border-radius: var(--radius-sm);
  color: var(--color-text);
  overflow-wrap: anywhere;
}
.auth-alert:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
</style>
