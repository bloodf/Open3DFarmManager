<script setup lang="ts">
import { useId } from 'vue'

withDefaults(
  defineProps<{ label: string; value: number; min?: number; max?: number }>(),
  { min: 0, max: 100 },
)
const id = useId()
</script>

<template>
  <div>
    <label :for="id">{{ label }}</label>
    <meter :id="id" :value="value" :min="min" :max="max" />
  </div>
</template>

<style scoped>
meter {
  display: block;
  inline-size: 100%;
  max-inline-size: 100%;
  accent-color: var(--ops-action);
}
</style>
