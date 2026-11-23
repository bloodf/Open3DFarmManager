<script setup lang="ts">
const paths = {
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12l4 4L19 6',
  info: 'M12 11v6m0-10v1M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  refresh: 'M20 10a8 8 0 1 0-1 7m1-12v5h-5',
}

defineProps<{ name: keyof typeof paths }>()
</script>

<template>
  <svg
    aria-hidden="true"
    focusable="false"
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path :d="paths[name]" />
  </svg>
</template>
