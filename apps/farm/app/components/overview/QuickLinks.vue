<script setup lang="ts">
// Entry points of the home page. Labels and targets are the app's own routes;
// nothing here sends a request.
defineProps<{ links: readonly { to: string; label: string }[] }>()
</script>

<template>
  <nav aria-label="Acessos rápidos">
    <ul class="quick-links">
      <li v-for="link in links" :key="link.to">
        <NuxtLink :to="link.to">{{ link.label }}</NuxtLink>
      </li>
    </ul>
  </nav>
</template>

<style scoped>
.quick-links {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 15rem), 1fr));
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}
.quick-links li {
  min-width: 0;
}
.quick-links a {
  display: flex;
  align-items: center;
  min-height: 2.75rem;
  height: 100%;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  overflow-wrap: anywhere;
}
.quick-links a:hover {
  border-color: var(--color-accent);
}
.quick-links a:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
</style>
