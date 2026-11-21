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
  font-weight: var(--font-weight-semibold);
}
.auth-submit.primary {
  background: var(--color-accent);
  color: var(--color-on-accent);
}
.auth-submit:disabled {
  cursor: wait;
}
</style>
