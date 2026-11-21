<script setup lang="ts">
import { ref } from 'vue'

// Live region for the result of an action. It is always in the DOM so screen
// readers announce text added later, and it takes focus after an action.
defineProps<{ message: string; error?: boolean }>()
const element = ref<HTMLElement | null>(null)
defineExpose({ focus: () => element.value?.focus() })
</script>

<template>
  <p
    ref="element"
    class="settings-message"
    :class="{ failure: error, filled: message !== '' }"
    :role="error ? 'alert' : 'status'"
    tabindex="-1"
  >
    {{ message }}
  </p>
</template>

<style scoped>
.settings-message {
  margin: 0;
}
/* Empty, it stays in the accessibility tree but takes no space in the grid. */
.settings-message:not(.filled) {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
.settings-message.filled {
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-inline-start-width: var(--space-1);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  overflow-wrap: anywhere;
}
/* The text and the glyph carry the outcome; the colour only reinforces it. */
.settings-message.filled::before {
  content: '✓ ';
  font-weight: var(--font-weight-semibold);
  color: var(--state-idle-color);
}
.settings-message.filled {
  border-color: var(--state-idle-color);
}
.settings-message.failure.filled {
  border-color: var(--state-error-color);
}
.settings-message.failure.filled::before {
  content: '! ';
  color: var(--state-error-color);
}
.settings-message:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
</style>
