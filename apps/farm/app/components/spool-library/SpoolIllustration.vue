<script setup lang="ts">
import { computed } from 'vue'
import { filamentSwatchBackground } from '../../utils/spool-library-format.ts'
import type { FilamentItem } from '../../utils/spool-library-types.ts'

// Reel and winding layers adapted from orca-ui-foundation (MIT); see THIRD_PARTY_NOTICES.md.
const props = defineProps<{
  filament: Pick<
    FilamentItem,
    'color_hex' | 'multi_color_hexes' | 'multi_color_direction'
  >
  fraction: number | null
}>()
const files = import.meta.glob<string>('../../assets/spool/*.webp', {
  eager: true,
  import: 'default',
})
const fill = [1, 0.85, 0.7, 0.55, 0.4, 0.25, 0.08]
const paint = computed(() => filamentSwatchBackground(props.filament))
const known = computed(
  () => props.fraction !== null && Number.isFinite(props.fraction),
)
const unknown = computed(() => !known.value)
const level = computed(() => {
  if (!known.value) return paint.value ? 1 : 8
  const fraction = props.fraction ?? 0
  if (fraction <= 0) return 8
  let best = 0
  for (let i = 1; i < fill.length; i++) {
    if (Math.abs(fill[i]! - fraction) < Math.abs(fill[best]! - fraction))
      best = i
  }
  return best + 1
})
const body = computed(
  () => files[`../../assets/spool/n${level.value}-corpo.webp`],
)
const wind = computed(
  () => files[`../../assets/spool/n${level.value}-fio.webp`],
)
</script>

<template>
  <span
    class="spool-illustration"
    :data-level="level"
    :data-unknown="unknown || undefined"
    aria-hidden="true"
  >
    <img
      class="spool-body"
      :src="body"
      alt=""
      width="160"
      height="160"
      draggable="false"
    />
    <span
      v-if="wind"
      class="spool-wind"
      :style="{
        background: paint || 'var(--color-text-muted)',
        maskImage: `url(${wind})`,
        WebkitMaskImage: `url(${wind})`,
      }"
    >
      <img :src="wind" alt="" width="160" height="160" draggable="false" />
    </span>
    <span v-if="unknown" class="spool-unknown">?</span>
  </span>
</template>

<style scoped>
.spool-illustration {
  position: relative;
  display: block;
  flex: none;
  width: 4rem;
  height: 4rem;
  isolation: isolate;
}
.spool-illustration img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  user-select: none;
}
.spool-wind {
  position: absolute;
  inset: 0;
  mask-position: center;
  mask-size: 100% 100%;
  mask-repeat: no-repeat;
}
.spool-wind img {
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
.spool-body {
  filter: drop-shadow(0 0 1px var(--color-text-muted));
}
</style>
