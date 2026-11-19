<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ label: string; value: number }>()
const percent = computed(() =>
  Number.isFinite(props.value) ? Math.min(100, Math.max(0, props.value)) : 0,
)
const text = computed(() =>
  new Intl.NumberFormat('pt-BR', {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(percent.value / 100),
)
</script>

<template>
  <div
    role="progressbar"
    :aria-label="label"
    :aria-valuenow="percent"
    :aria-valuetext="text"
  >
    <svg viewBox="0 0 64 64" width="64" height="64" aria-hidden="true">
      <circle
        cx="32"
        cy="32"
        r="27"
        fill="none"
        stroke="currentColor"
        stroke-width="4"
        opacity=".2"
      />
      <circle
        cx="32"
        cy="32"
        r="27"
        fill="none"
        stroke="currentColor"
        stroke-width="4"
        pathLength="100"
        :stroke-dasharray="`${percent} 100`"
        transform="rotate(-90 32 32)"
      />
      <text
        x="32"
        y="32"
        text-anchor="middle"
        dominant-baseline="central"
        fill="currentColor"
        font-size="13"
      >
        {{ text }}
      </text>
    </svg>
  </div>
</template>
