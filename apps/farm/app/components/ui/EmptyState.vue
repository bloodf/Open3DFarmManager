<script setup lang="ts">
import Card from './Card.vue'

withDefaults(
  defineProps<{ title: string; description?: string; level?: 2 | 3 }>(),
  { level: 2 },
)
</script>

<template>
  <Card>
    <component :is="`h${level}`">{{ title }}</component>
    <p v-if="description">{{ description }}</p>
    <slot />
  </Card>
</template>
