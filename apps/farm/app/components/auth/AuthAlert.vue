<script setup lang="ts">
import { ref } from 'vue'
import Icon from '../ui/Icon.vue'

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
    <Icon v-if="message" name="info" />
    <span>{{ message }}</span>
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
  display: flex;
  align-items: flex-start;
  gap: var(--ops-space-2);
  padding: var(--ops-space-2) var(--ops-space-3);
  border-inline-start: 3px solid var(--ops-fault);
  border-radius: var(--ops-radius-sm);
  background: var(--ops-fault-bg);
  color: var(--ops-fault);
  line-height: 20px;
  overflow-wrap: anywhere;
}
.auth-alert svg {
  flex: none;
}
.auth-alert:focus-visible {
  outline: var(--focus-ring-width) solid var(--ops-action);
  outline-offset: 2px;
}
</style>
