<script setup lang="ts">
defineProps<{ title: string; description?: string }>()
</script>
<template>
  <header class="page-header">
    <div>
      <h1>{{ title }}</h1>
      <p v-if="description">{{ description }}</p>
    </div>
    <div><slot /></div>
  </header>
</template>
<style scoped>
.page-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--ops-space-3);
}
h1 {
  font-size: var(--ops-text-title);
  line-height: 24px;
  margin: 0;
}
p {
  color: var(--ops-muted);
  margin: var(--ops-space-1) 0 0;
}
</style>
