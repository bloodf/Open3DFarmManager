<script setup lang="ts">
import Card from './Card.vue'

defineProps<{ title: string; description?: string }>()
</script>

<template>
  <Card>
    <h2>{{ title }}</h2>
    <p v-if="description">{{ description }}</p>
    <slot />
  </Card>
</template>
