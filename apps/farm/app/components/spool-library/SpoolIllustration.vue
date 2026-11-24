<script setup lang="ts">
import { computed } from 'vue'
import {
  filamentSwatchBackground,
  spoolRemainingFraction,
} from '../../utils/spool-library-format.ts'
import type {
  FilamentItem,
  SpoolItem,
} from '../../utils/spool-library-types.ts'
import { formatPercentage } from '../../utils/ui-format.ts'

// Reel and winding layers adapted from orca-ui-foundation (MIT); see THIRD_PARTY_NOTICES.md.
const props = defineProps<{
  spool?: SpoolItem
  filament?: Pick<
    FilamentItem,
    'color_hex' | 'multi_color_hexes' | 'multi_color_direction'
  >
  spoolmanPercent?: number | null
  printerPercent?: number | null
  compact?: boolean
}>()
const fill = [1, 0.85, 0.7, 0.55, 0.4, 0.25, 0.08]
const paint = computed(() =>
  filamentSwatchBackground(props.spool?.filament ?? props.filament ?? {}),
)
function percentFraction(percent: number | null | undefined) {
  return percent != null && Number.isFinite(percent)
    ? Math.max(0, Math.min(1, percent / 100))
    : null
}
const fraction = computed(
  () =>
    (props.spool ? spoolRemainingFraction(props.spool) : null) ??
    percentFraction(props.spoolmanPercent) ??
    percentFraction(props.printerPercent),
)
const unknown = computed(() => fraction.value === null)
const level = computed(() => {
  const remaining = fraction.value
  if (remaining === null) return 1
  if (remaining === 0) return 8
  let best = 0
  for (let i = 1; i < fill.length; i++) {
    if (Math.abs(fill[i]! - remaining) < Math.abs(fill[best]! - remaining))
      best = i
  }
  return best + 1
})
const label = computed(() =>
  fraction.value === null
    ? 'Nível restante desconhecido'
    : `Nível restante: ${formatPercentage(fraction.value * 100)}`,
)
</script>

<template>
  <span
    class="spool-illustration"
    :class="{ compact }"
    :data-level="level"
    :data-unknown="unknown || undefined"
    role="img"
    :aria-label="label"
  >
    <span
      v-if="level !== 8"
      class="spool-wind"
      :style="{ background: paint || 'var(--color-text-muted)' }"
    />
    <span v-if="unknown" class="spool-unknown" aria-hidden="true">?</span>
  </span>
</template>

<style scoped>
.spool-illustration {
  position: relative;
  display: inline-block;
  flex: none;
  inline-size: 4rem;
  block-size: 4rem;
  vertical-align: middle;
  isolation: isolate;
}
.spool-illustration.compact {
  inline-size: 2.5rem;
  block-size: 2.5rem;
}
.spool-illustration::before,
.spool-wind::after {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--reel-image) center / contain no-repeat;
}
.spool-illustration::before {
  filter: drop-shadow(0 0 1px var(--color-text-muted));
}
.spool-wind {
  position: absolute;
  inset: 0;
  mask: var(--winding-image) center / contain no-repeat;
}
.spool-wind::after {
  background-image: var(--winding-image);
  mix-blend-mode: hard-light;
}
.spool-unknown {
  position: absolute;
  top: 0;
  right: 0;
  display: grid;
  place-items: center;
  width: 1.25rem;
  height: 1.25rem;
  border: 1px solid var(--color-border);
  border-radius: 50%;
  color: var(--color-text);
  background: var(--color-surface-raised);
  font-size: var(--font-size-sm);
  font-weight: 700;
  line-height: 1;
}
.compact .spool-unknown {
  width: 1rem;
  height: 1rem;
}
[data-level='1'] {
  --reel-image: url('../../assets/spool/n1-corpo.webp');
  --winding-image: url('../../assets/spool/n1-fio.webp');
}
[data-level='2'] {
  --reel-image: url('../../assets/spool/n2-corpo.webp');
  --winding-image: url('../../assets/spool/n2-fio.webp');
}
[data-level='3'] {
  --reel-image: url('../../assets/spool/n3-corpo.webp');
  --winding-image: url('../../assets/spool/n3-fio.webp');
}
[data-level='4'] {
  --reel-image: url('../../assets/spool/n4-corpo.webp');
  --winding-image: url('../../assets/spool/n4-fio.webp');
}
[data-level='5'] {
  --reel-image: url('../../assets/spool/n5-corpo.webp');
  --winding-image: url('../../assets/spool/n5-fio.webp');
}
[data-level='6'] {
  --reel-image: url('../../assets/spool/n6-corpo.webp');
  --winding-image: url('../../assets/spool/n6-fio.webp');
}
[data-level='7'] {
  --reel-image: url('../../assets/spool/n7-corpo.webp');
  --winding-image: url('../../assets/spool/n7-fio.webp');
}
[data-level='8'] {
  --reel-image: url('../../assets/spool/n8-corpo.webp');
}
</style>
