<script setup lang="ts">
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 bloodf
// Ported from bloodf/orca-ui-foundation src/components/OuiSpool.vue @ e4d93af0cf576660ad4b80ac5d5a1cdef4a5c795
// (MIT, see THIRD_PARTY_NOTICES.md). The render files in public/spool-art are the upstream src/assets/spool/*.webp.
// Changes: OpenFarm --ops-* tokens, pt-BR copy, no hard-coded colours, and an unknown amount always draws the full
// reel with a visible "desconhecido" badge.
import { computed } from 'vue'
import { spoolLevelLabel } from '../../utils/spool-level.ts'

/*
 * A spool as an object: a product render of the reel with the winding in the filament's own colour, as deep as the
 * filament left. Eight renders of the same spool, from full (1) to an empty reel (8), each in two layers
 * (public/spool-art): "corpo", the neutral black reel, and "fio", a grey light map whose alpha says where the filament
 * is. The colour is in no file: it is painted under the map and mixed with hard-light, so mid-grey gives the exact
 * colour, shadow darkens and highlights lighten.
 *
 * The drawing is decorative: the material name and the amount are always text next to it, so colour is never the only
 * signal. `fraction` null means the amount is unknown: the full reel plus a "desconhecido" badge, never a made-up level.
 * No colour paints the winding with a neutral token, never a guessed colour.
 */
const props = withDefaults(
  defineProps<{
    color?: string | null
    colors?: string[] | null
    /** How a multi-colour filament's colours run: side by side (default), around the spool (coaxial) or along it (longitudinal). */
    direction?: 'coaxial' | 'longitudinal' | null
    /** Filament left, 0..1; null when unknown. Use `resolveSpoolLevel` to get it. */
    fraction?: number | null
    size?: number
    announceLevel?: boolean
  }>(),
  { color: null, colors: null, direction: null, fraction: null, size: 40 },
)

/** How much each render shows wound on the reel. */
const LEVEL_FILL = [1, 0.85, 0.7, 0.55, 0.4, 0.25, 0.08, 0]
const base = '/spool-art'
const src = (name: string) => `${base}/${name}.webp`

const known = computed(
  () => typeof props.fraction === 'number' && Number.isFinite(props.fraction),
)
const unknown = computed(() => !known.value)
const hasColor = computed(() =>
  Boolean(props.color || props.colors?.some(Boolean)),
)
// The render closest to the fraction. Any filament left, however little, is still level 7 ("almost empty"): the bare
// reel (8) is only for a spool with nothing on it.
const level = computed(() => {
  if (unknown.value) return 1
  const f = Math.min(1, Math.max(0, props.fraction as number))
  if (f <= 0) return 8
  let best = 0
  for (let n = 1; n < 7; n++)
    if (Math.abs(LEVEL_FILL[n]! - f) < Math.abs(LEVEL_FILL[best]! - f)) best = n
  return best + 1
})
const body = computed(() => src(`n${level.value}-corpo`))
const wind = computed(() => (level.value < 8 ? src(`n${level.value}-fio`) : ''))
const paint = computed(() => {
  const cs = props.colors && props.colors.length > 1 ? props.colors : null
  if (!cs) return props.color || props.colors?.[0] || 'var(--ops-idle)'
  if (props.direction === 'longitudinal')
    return `linear-gradient(135deg, ${cs.join(', ')})`
  if (props.direction === 'coaxial') {
    const step = 360 / cs.length
    return (
      'conic-gradient(' +
      cs.map((c, i) => `${c} ${i * step}deg ${(i + 1) * step}deg`).join(', ') +
      ')'
    )
  }
  return (
    'linear-gradient(90deg, ' +
    cs
      .map(
        (c, i) =>
          `${c} ${(i * 100) / cs.length}% ${((i + 1) * 100) / cs.length}%`,
      )
      .join(', ') +
    ')'
  )
})
// Plain pixels on the element itself: the box never depends on a custom property or aspect-ratio being supported.
const px = computed(() => `${props.size}px`)
</script>

<template>
  <span
    class="farm-spool"
    :role="announceLevel ? 'img' : undefined"
    :aria-label="announceLevel ? spoolLevelLabel(fraction) : undefined"
    :data-level="level"
    :data-unknown="unknown || undefined"
    :data-color="hasColor ? 'set' : 'missing'"
    :style="{ minWidth: px }"
  >
    <span
      class="farm-spool-art"
      :style="{ width: px, height: px, '--farm-spool-paint': paint }"
      aria-hidden="true"
    >
      <img
        class="farm-spool-body"
        :src="body"
        alt=""
        width="160"
        height="160"
        draggable="false"
      />
      <span
        v-if="wind"
        class="farm-spool-wind"
        :style="{ '--farm-spool-map': `url(${wind})` }"
        ><img :src="wind" alt="" width="160" height="160" draggable="false"
      /></span>
    </span>
    <span v-if="unknown" class="farm-spool-unknown">desconhecido</span>
  </span>
</template>

<style>
/* The box is a fixed square (width and height inline in px) with the images contained in it. Not clipped, so the dark
   theme's rim light fades out instead of ending in a square. */
.farm-spool {
  display: inline-flex;
  flex: none;
  flex-direction: column;
  align-items: center;
  gap: var(--ops-space-1);
  inline-size: max-content;
  max-inline-size: 100%;
}
.farm-spool-art {
  position: relative;
  display: block;
  flex: none;
  isolation: isolate;
}
.farm-spool-art img {
  display: block;
  width: 100%;
  height: 100%;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  user-select: none;
}
.farm-spool-wind {
  position: absolute;
  inset: 0;
  background: var(--farm-spool-paint);
  -webkit-mask: var(--farm-spool-map) center / 100% 100% no-repeat;
  mask: var(--farm-spool-map) center / 100% 100% no-repeat;
}
.farm-spool-wind img {
  mix-blend-mode: hard-light;
}
/* Unknown amount: a text badge in the page's own surface, text and border so it reads on both themes. */
.farm-spool-unknown {
  padding: 0 var(--ops-space-2);
  border: 1px solid var(--ops-border);
  border-radius: var(--ops-radius-lg);
  background: var(--ops-raised);
  color: var(--ops-text);
  font-size: var(--ops-text-label);
  font-weight: 600;
  line-height: 1.5;
  white-space: nowrap;
}
/* A contact shadow: the spool stands on the card, it does not float. */
.farm-spool-art::after {
  content: '';
  position: absolute;
  z-index: -1;
  left: 14%;
  right: 14%;
  bottom: 1%;
  height: 8%;
  border-radius: 50%;
  background: radial-gradient(
    closest-side,
    color-mix(in srgb, var(--ops-text) 28%, transparent),
    transparent
  );
}
/* The reel is black: on the dark theme it gets a soft light rim so it does not disappear into the card. */
[data-theme='dark'] .farm-spool-body {
  filter: drop-shadow(
      0 0 0.6px color-mix(in srgb, var(--ops-text) 55%, transparent)
    )
    drop-shadow(0 0 6px color-mix(in srgb, var(--ops-text) 10%, transparent));
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) .farm-spool-body {
    filter: drop-shadow(
        0 0 0.6px color-mix(in srgb, var(--ops-text) 55%, transparent)
      )
      drop-shadow(0 0 6px color-mix(in srgb, var(--ops-text) 10%, transparent));
  }
}
</style>
