<script setup lang="ts">
// Shared frame of the first-access, account, pairing and devices screens:
// eyebrow, page title, optional intro and a column that never overflows.
// The heading can take focus (devices moves it there on load).
defineProps<{
  title: string
  /** Narrow single-column layout for account forms. */
  narrow?: boolean
  /** Instrument-panel look of the account and pairing screens. */
  access?: boolean
}>()
const heading = ref<HTMLElement | null>(null)
defineExpose({ focusHeading: () => heading.value?.focus() })
</script>

<template>
  <main id="conteudo" class="onboarding-page" :class="{ narrow, access }">
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
.onboarding-page.access {
  max-width: 40rem;
  padding: var(--ops-space-5) var(--ops-space-4);
  font-size: var(--ops-text-body);
  line-height: 20px;
}
.onboarding-page.access.narrow {
  max-width: 26rem;
}
.access .page-header {
  display: grid;
  gap: var(--ops-space-1);
  padding-block-end: var(--ops-space-3);
  border-block-end: 1px solid var(--ops-border);
}
.access .eyebrow {
  margin: 0;
  font-family: var(--ops-font-mono);
  font-size: var(--ops-text-label);
  font-weight: var(--font-weight-semibold);
  letter-spacing: 0.08em;
  line-height: 16px;
  color: var(--ops-muted);
}
.access h1 {
  margin: 0;
  font-size: var(--ops-text-title);
  line-height: 24px;
  overflow-wrap: anywhere;
  text-wrap: balance;
}
.access h1:focus-visible {
  outline: var(--focus-ring-width) solid var(--ops-action);
  outline-offset: 2px;
}
.access .intro {
  gap: var(--ops-space-2);
  color: var(--ops-muted);
}
.access :deep(p) {
  line-height: 20px;
}
.access :deep(a) {
  color: var(--ops-action);
}
.access :deep(a:focus-visible) {
  outline: var(--focus-ring-width) solid var(--ops-action);
  outline-offset: 2px;
}
.access :deep(.panel) {
  gap: var(--ops-space-4);
  padding: var(--ops-space-4);
  border-color: var(--ops-border);
  border-radius: var(--ops-radius-lg);
  background: var(--ops-panel);
  color: var(--ops-text);
}
.access :deep(.panel h2) {
  flex: 1;
  padding-block-end: var(--ops-space-2);
  border-block-end: 1px solid var(--ops-border);
  font-size: var(--ops-text-body);
  line-height: 20px;
}
.access :deep(.field label) {
  font-size: var(--ops-text-small);
}
.access :deep(.field .help) {
  font-size: var(--ops-text-small);
  line-height: 18px;
  color: var(--ops-muted);
}
.access :deep(.field input:not([type='checkbox'])),
.access :deep(.field select) {
  background: var(--ops-canvas);
  border-color: color-mix(in srgb, var(--ops-muted) 70%, var(--ops-panel));
  border-radius: var(--ops-radius-md);
}
.access :deep(.field input:focus-visible),
.access :deep(.field select:focus-visible) {
  outline: var(--focus-ring-width) solid var(--ops-action);
  outline-offset: 2px;
}
.access :deep(.notice) {
  padding: var(--ops-space-3);
  border-color: var(--ops-border);
  border-inline-start: 3px solid var(--ops-action);
  border-radius: var(--ops-radius-sm);
  background: var(--ops-panel);
  color: var(--ops-text);
}
.access :deep(.notice.warning) {
  border-color: var(--ops-attention);
  background: var(--ops-attention-bg);
  color: var(--ops-attention);
}
/* Below 16px, touch browsers zoom the page when a field takes focus. */
@media (pointer: coarse) {
  .access :deep(.field input:not([type='checkbox'])),
  .access :deep(.field select) {
    font-size: 1rem;
  }
}
</style>
