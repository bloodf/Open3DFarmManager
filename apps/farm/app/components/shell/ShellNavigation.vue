<script setup lang="ts">
defineProps<{ links: { to: string; label: string }[]; path: string }>()
const emit = defineEmits<{ navigate: [] }>()
</script>

<template>
  <nav aria-label="Navegação principal">
    <NuxtLink
      v-for="link in links"
      :key="link.to"
      :to="link.to"
      :aria-current="path === link.to ? 'page' : undefined"
      @click="emit('navigate')"
    >
      {{ link.label }}
    </NuxtLink>
  </nav>
</template>

<style scoped>
nav {
  display: grid;
  gap: var(--space-2);
}
a {
  display: flex;
  align-items: center;
  min-block-size: 2.75rem;
  padding-inline: var(--space-2);
  overflow-wrap: anywhere;
}
a[aria-current='page'] {
  background: var(--surface);
  font-weight: 700;
}
</style>
