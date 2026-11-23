<script setup lang="ts">
import { computed } from 'vue'

defineOptions({ inheritAttrs: false })
const props = defineProps<{
  id: string
  label: string
  hint?: string
  /** Extra ids that describe the field, e.g. a help text shared by two fields. */
  describedby?: string
}>()
const model = defineModel<string>({ required: true })
const described = computed(
  () =>
    [props.hint && `${props.id}-help`, props.describedby]
      .filter(Boolean)
      .join(' ') || undefined,
)
</script>

<template>
  <div class="auth-field">
    <label :for="id">{{ label }}</label>
    <input
      :id="id"
      v-model="model"
      v-bind="$attrs"
      :aria-describedby="described"
    />
    <p v-if="hint" :id="`${id}-help`" class="help">{{ hint }}</p>
  </div>
</template>

<style scoped>
.auth-field {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
}
label {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
}
input {
  width: 100%;
  min-height: 2.75rem;
  padding: var(--space-2) var(--space-3);
  font: inherit;
  color: inherit;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}
input:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
input:disabled {
  opacity: 0.6;
}
.help {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  overflow-wrap: anywhere;
}
</style>
