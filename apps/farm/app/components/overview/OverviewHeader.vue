<script setup lang="ts">
import { ref } from 'vue'

// Page header shared by the overview screens: eyebrow, the one h1 and an
// intro. The h1 takes focus on demand so each page keeps its focus order.
defineProps<{ title: string; eyebrow?: string; intro?: string }>()

const heading = ref<HTMLElement | null>(null)
defineExpose({ focus: () => heading.value?.focus() })
</script>

<template>
  <header class="overview-header">
    <p v-if="eyebrow" class="overview-header__eyebrow">{{ eyebrow }}</p>
    <h1 ref="heading" tabindex="-1">{{ title }}</h1>
    <p v-if="intro" class="overview-header__intro">{{ intro }}</p>
    <slot />
  </header>
</template>

<style scoped>
.overview-header {
  display: grid;
  gap: var(--space-2);
}
.overview-header__eyebrow {
  margin: 0;
  font-size: var(--font-size-sm);
  letter-spacing: 0.04em;
  color: var(--color-text-muted);
}
h1 {
  margin: 0;
  overflow-wrap: anywhere;
}
h1:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
  border-radius: var(--radius-sm);
}
.overview-header__intro {
  margin: 0;
  color: var(--color-text-muted);
}
</style>
