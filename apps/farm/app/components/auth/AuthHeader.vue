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
.intro {
  margin: 0;
  color: var(--color-text-muted);
}
</style>
