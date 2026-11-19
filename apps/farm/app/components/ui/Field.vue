<script setup lang="ts">
import { computed, useId } from 'vue'

const props = defineProps<{ label: string; hint?: string; error?: string }>()
const id = useId()
const control = computed(() => ({
  id,
  'aria-describedby':
    [props.hint && `${id}-hint`, props.error && `${id}-error`]
      .filter(Boolean)
      .join(' ') || undefined,
  'aria-invalid': props.error ? true : undefined,
}))
</script>

<template>
  <div class="field">
    <label :for="id">{{ label }}</label>
    <slot :control="control" />
    <span v-if="hint" :id="`${id}-hint`">{{ hint }}</span>
    <span v-if="error" :id="`${id}-error`" class="error">{{ error }}</span>
  </div>
</template>

<style scoped>
.field {
  display: grid;
  gap: var(--space-1);
}
label {
  font-weight: 600;
}
.error {
  color: var(--printer-error);
}
</style>
