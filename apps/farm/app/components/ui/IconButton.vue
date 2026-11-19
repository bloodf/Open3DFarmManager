<script setup lang="ts">
import Button from './Button.vue'
import Icon from './Icon.vue'

defineProps<{
  label: string
  icon: InstanceType<typeof Icon>['$props']['name']
}>()
</script>

<template>
  <Button :aria-label="label"><Icon :name="icon" /></Button>
</template>
