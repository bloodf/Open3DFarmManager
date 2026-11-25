<script setup lang="ts">
defineProps<{ eyebrow?: string; title: string }>()
</script>

<template>
  <header class="auth-header">
    <p v-if="eyebrow" class="eyebrow">{{ eyebrow }}</p>
    <h1>{{ title }}</h1>
    <p class="intro"><slot /></p>
  </header>
</template>

<style scoped>
.auth-header {
  display: grid;
  gap: var(--ops-space-1);
  padding-block-end: var(--ops-space-3);
  border-block-end: 1px solid var(--ops-border);
}
.eyebrow {
  margin: 0;
  font-family: var(--ops-font-mono);
  font-size: var(--ops-text-label);
  font-weight: var(--font-weight-semibold);
  letter-spacing: 0.08em;
  line-height: 16px;
  color: var(--ops-muted);
}
h1 {
  margin: 0;
  font-size: var(--ops-text-title);
  line-height: 24px;
  overflow-wrap: anywhere;
  text-wrap: balance;
}
.intro {
  margin: 0;
  line-height: 20px;
  color: var(--ops-muted);
}
</style>
