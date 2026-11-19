<script setup lang="ts">
import { useId } from 'vue'

withDefaults(defineProps<{ label: string; value?: number; max?: number }>(), {
  max: 100,
})
const id = useId()
</script>

<template>
  <div>
    <label :for="id">{{ label }}</label>
    <progress :id="id" :value="value" :max="max" />
  </div>
</template>

<style scoped>
progress {
  display: block;
  max-inline-size: 100%;
  accent-color: var(--accent);
}
</style>
