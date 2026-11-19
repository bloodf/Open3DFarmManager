<script setup lang="ts">
import Card from './Card.vue'

defineProps<{ title: string; description?: string }>()
</script>

<template>
  <Card>
    <h2 class="error">{{ title }}</h2>
    <p v-if="description">{{ description }}</p>
    <slot />
  </Card>
</template>

<style scoped>
.error {
  color: var(--printer-error);
}
</style>
