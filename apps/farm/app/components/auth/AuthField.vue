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
  gap: var(--ops-space-1);
  min-width: 0;
}
label {
  font-size: var(--ops-text-small);
  font-weight: var(--font-weight-semibold);
}
input {
  width: 100%;
  min-height: 2.75rem;
  padding: var(--ops-space-2) var(--ops-space-3);
  font: inherit;
  color: inherit;
  background: var(--ops-canvas);
  border: 1px solid color-mix(in srgb, var(--ops-muted) 70%, var(--ops-panel));
  border-radius: var(--ops-radius-md);
}
input:focus-visible {
  outline: var(--focus-ring-width) solid var(--ops-action);
  outline-offset: 2px;
}
input:disabled {
  opacity: 0.6;
}
.help {
  margin: 0;
  font-size: var(--ops-text-small);
  line-height: 18px;
  color: var(--ops-muted);
  overflow-wrap: anywhere;
}
/* Below 16px, touch browsers zoom the page when a field takes focus. */
@media (pointer: coarse) {
  input {
    font-size: 1rem;
  }
}
</style>
