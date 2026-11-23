<script setup lang="ts">
import { useId } from 'vue'

// A checkbox with its label and an optional hint tied to it.
defineProps<{
  modelValue: boolean
  label: string
  hint?: string
  disabled?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
const hintId = useId()
function update(event: Event) {
  if (event.target instanceof HTMLInputElement)
    emit('update:modelValue', event.target.checked)
}
</script>

<template>
  <div class="toggle">
    <label class="toggle-label">
      <input
        type="checkbox"
        :checked="modelValue"
        :disabled="disabled"
        :aria-describedby="hint ? hintId : undefined"
        @change="update"
      />
      <span>{{ label }}</span>
    </label>
    <p v-if="hint" :id="hintId" class="hint">{{ hint }}</p>
  </div>
</template>

<style scoped>
.toggle {
  display: grid;
  gap: var(--space-1);
}
.toggle-label {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-block-size: 2.75rem;
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
}
input {
  flex: 0 0 auto;
  inline-size: 1.25rem;
  block-size: 1.25rem;
  margin: 0;
  accent-color: var(--color-accent);
}
input:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.hint {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}
</style>
