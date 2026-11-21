<script setup lang="ts">
import Field from '../ui/Field.vue'

// A labelled text or password input built on the shared Field: the label,
// hint and error are wired to the control by id. Native attributes
// (autocomplete, required, minlength, disabled, ...) go to the input.
defineOptions({ inheritAttrs: false })
withDefaults(
  defineProps<{
    label: string
    modelValue: string
    hint?: string
    error?: string
    type?: 'text' | 'password'
  }>(),
  { type: 'text' },
)
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
function update(event: Event) {
  if (event.target instanceof HTMLInputElement)
    emit('update:modelValue', event.target.value)
}
</script>

<template>
  <Field
    v-slot="{ control }"
    class="settings-field"
    :label="label"
    :hint="hint"
    :error="error"
  >
    <input
      v-bind="{ ...control, ...$attrs }"
      class="settings-input"
      :type="type"
      :value="modelValue"
      @input="update"
    />
  </Field>
</template>

<style scoped>
.settings-field {
  max-inline-size: 28rem;
}
.settings-field :deep(label) {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
}
.settings-field :deep(span:not(.error)) {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}
.settings-input {
  inline-size: 100%;
  min-block-size: 2.75rem;
  padding: var(--space-2) var(--space-3);
  font: inherit;
  color: inherit;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}
.settings-input:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.settings-input::placeholder {
  color: var(--color-text-muted);
}
.settings-input:disabled {
  opacity: 0.6;
}
</style>
