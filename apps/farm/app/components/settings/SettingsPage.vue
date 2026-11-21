<script setup lang="ts">
import { onMounted, ref } from 'vue'

// Shared frame of the account and network settings screens: one main
// landmark, one h1, the brand eyebrow and an optional intro, then the content.
const props = defineProps<{
  title: string
  /** Moves keyboard focus to the h1 when the page opens. */
  focusHeading?: boolean
}>()
const heading = ref<HTMLElement | null>(null)
onMounted(() => {
  if (props.focusHeading) heading.value?.focus()
})
</script>

<template>
  <main id="conteudo" class="settings-page">
    <header class="page-header">
      <p class="eyebrow">Open3DFarmManager</p>
      <h1 ref="heading" :tabindex="focusHeading ? -1 : undefined">
        {{ title }}
      </h1>
      <p v-if="$slots.intro" class="intro"><slot name="intro" /></p>
    </header>
    <slot />
  </main>
</template>

<style scoped>
.settings-page {
  display: grid;
  gap: var(--space-4);
  align-content: start;
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
.page-header h1 {
  margin: 0;
  overflow-wrap: anywhere;
}
.page-header h1:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
  border-radius: var(--radius-sm);
}
.intro {
  margin: 0;
  color: var(--color-text-muted);
}
/* Same bordered surface as the settings panels for the shared state cards. */
.settings-page :deep(.ui-card) {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-5);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: none;
}
.settings-page :deep(.ui-card > h2),
.settings-page :deep(.ui-card > h3) {
  margin: 0;
  font-size: var(--font-size-lg);
  line-height: var(--line-height-tight);
}
.settings-page :deep(.ui-card > p) {
  margin: 0;
}
.settings-page :deep(.stale) {
  border-radius: var(--radius-md);
}
.settings-page :deep(.stale p) {
  margin: 0;
}
@media (max-width: 30rem) {
  .settings-page :deep(.ui-card) {
    padding: var(--space-4);
  }
}
</style>
