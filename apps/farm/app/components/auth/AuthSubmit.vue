<script setup lang="ts">
import Button from '../ui/Button.vue'

withDefaults(defineProps<{ variant?: 'primary' | 'secondary' }>(), {
  variant: 'primary',
})
</script>

<template>
  <Button type="submit" class="auth-submit" :class="variant"><slot /></Button>
</template>

<style scoped>
.auth-submit.auth-submit {
  width: 100%;
  border-radius: var(--ops-radius-md);
  font-weight: var(--font-weight-semibold);
}
.auth-submit.primary {
  border-color: var(--ops-action);
  background: var(--ops-action);
  color: var(--ops-on-action);
}
.auth-submit.secondary {
  border-color: color-mix(in srgb, var(--ops-muted) 70%, var(--ops-panel));
  background: var(--ops-raised);
  color: var(--ops-text);
}
.auth-submit.primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ops-action) 88%, var(--ops-text));
}
.auth-submit.secondary:hover:not(:disabled) {
  border-color: var(--ops-action);
}
.auth-submit:focus-visible {
  outline: var(--focus-ring-width) solid var(--ops-action);
  outline-offset: 2px;
}
.auth-submit:disabled {
  cursor: wait;
}
</style>
