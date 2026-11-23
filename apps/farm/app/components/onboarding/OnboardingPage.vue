<script setup lang="ts">
// Shared frame of the first-access, account, pairing and devices screens:
// eyebrow, page title, optional intro and a column that never overflows.
// The heading can take focus (devices moves it there on load).
defineProps<{
  title: string
  /** Narrow single-column layout for account forms. */
  narrow?: boolean
}>()
const heading = ref<HTMLElement | null>(null)
defineExpose({ focusHeading: () => heading.value?.focus() })
</script>

<template>
  <main id="conteudo" class="onboarding-page" :class="{ narrow }">
    <header class="page-header">
      <p class="eyebrow">Open3DFarmManager</p>
      <h1 ref="heading" tabindex="-1">{{ title }}</h1>
      <div v-if="$slots.intro" class="intro"><slot name="intro" /></div>
    </header>
    <slot />
  </main>
</template>

<style scoped>
.onboarding-page {
  display: grid;
  gap: var(--space-4);
  align-content: start;
}
.onboarding-page.narrow {
  max-width: 34rem;
}
.page-header {
  display: grid;
  gap: var(--space-2);
}
.eyebrow {
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
.intro {
  display: grid;
  gap: var(--space-2);
  color: var(--color-text-muted);
}
.intro :deep(p) {
  margin: 0;
}
</style>
