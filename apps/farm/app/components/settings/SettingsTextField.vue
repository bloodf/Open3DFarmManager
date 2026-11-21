<script setup lang="ts">
import { computed, useId } from 'vue'

// A labelled text or password input: the label, hint and error are wired to
// the control by id. `id` is optional and stable when given (page contracts
// and anchors target it); otherwise one is generated. Native attributes
// (autocomplete, required, minlength, disabled, ...) go to the input.
defineOptions({ inheritAttrs: false })
const props = withDefaults(
  defineProps<{
    id?: string
    label: string
    modelValue: string
    hint?: string
    error?: string
    type?: 'text' | 'password'
  }>(),
  { type: 'text' },
)
const generated = useId()
const controlId = computed(() => props.id ?? generated)
const describedBy = computed(
  () =>
    [
      props.hint && `${controlId.value}-hint`,
      props.error && `${controlId.value}-error`,
    ]
      .filter(Boolean)
      .join(' ') || undefined,
)
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
function update(event: Event) {
  if (event.target instanceof HTMLInputElement)
    emit('update:modelValue', event.target.value)
}
</script>

<template>
  <div class="settings-field">
    <label :for="controlId">{{ label }}</label>
    <input
      v-bind="$attrs"
      :id="controlId"
      class="settings-input"
      :type="type"
      :value="modelValue"
      :aria-describedby="describedBy"
      :aria-invalid="error ? true : undefined"
      @input="update"
    />
    <span v-if="hint" :id="`${controlId}-hint`" class="hint">{{ hint }}</span>
    <span v-if="error" :id="`${controlId}-error`" class="error">{{
      error
    }}</span>
  </div>
</template>

<style scoped>
.settings-field {
  display: grid;
  gap: var(--space-1);
  max-inline-size: 28rem;
}
.settings-field label {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
}
.settings-field .hint {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}
.settings-field .error {
  font-size: var(--font-size-sm);
  color: var(--printer-error);
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
