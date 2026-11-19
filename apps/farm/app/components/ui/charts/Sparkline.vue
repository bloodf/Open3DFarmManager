<script setup lang="ts">
import { computed } from 'vue'
import { scale, sortedPoints, type ChartPoint } from './points.ts'

const props = defineProps<{ label: string; points: readonly ChartPoint[] }>()
const coordinates = computed(() => {
  const points = sortedPoints(props.points)
  const values = points.map(({ value }) => value)
  const x = scale(points[0]?.time ?? 0, points.at(-1)?.time ?? 0, 3, 117)
  const y = scale(Math.min(...values), Math.max(...values), 29, 3)
  return points.map(({ time, value }) => [x(time), y(value)] as const)
})
</script>

<template>
  <svg
    viewBox="0 0 120 32"
    width="120"
    height="32"
    role="img"
    :aria-label="coordinates.length ? label : `${label}: sem dados`"
  >
    <polyline
      v-if="coordinates.length > 1"
      :points="coordinates.map((point) => point.join(',')).join(' ')"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linejoin="round"
    />
    <circle
      v-else-if="coordinates[0]"
      :cx="coordinates[0][0]"
      :cy="coordinates[0][1]"
      r="2"
      fill="currentColor"
    />
  </svg>
</template>
