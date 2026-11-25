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
  gap: var(--ops-space-2);
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
  justify-content: space-between;
  gap: var(--ops-space-2);
  min-height: 2.75rem;
  height: 100%;
  padding: var(--ops-space-2) var(--ops-space-3);
  border: 1px solid var(--ops-border);
  border-inline-start: 3px solid var(--ops-action);
  border-radius: var(--ops-radius-md);
  background: var(--ops-panel);
  color: var(--ops-text);
  font-weight: var(--font-weight-semibold);
  text-decoration: none;
  overflow-wrap: anywhere;
}
/* Decorative chevron, drawn so it is not read as text. */
.quick-links a::after {
  content: '';
  flex: none;
  inline-size: 0.4rem;
  block-size: 0.4rem;
  border-block-start: 2px solid var(--ops-muted);
  border-inline-end: 2px solid var(--ops-muted);
  transform: rotate(45deg);
}
.quick-links a:hover {
  border-color: var(--ops-action);
  background: var(--ops-raised);
}
.quick-links a:focus-visible {
  outline: var(--focus-ring-width) solid var(--ops-action);
  outline-offset: 2px;
}
</style>
