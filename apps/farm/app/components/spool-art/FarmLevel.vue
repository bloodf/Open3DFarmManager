<script setup lang="ts">
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 bloodf
// Ported from bloodf/orca-ui-foundation src/components/OuiLevel.vue @ e4d93af0cf576660ad4b80ac5d5a1cdef4a5c795
// (MIT, see THIRD_PARTY_NOTICES.md). Changes: OpenFarm --ops-* tokens and an accessible name that is always set.
import { computed } from 'vue'

/*
 * How much is left (filament on a spool): green when fine, amber when `low`, red when `critical`, always with the
 * amount in text beside it. The filament's own colour is never used here. An unknown amount shows an empty hatched
 * track, not an empty bar, and is announced as "desconhecido", not as a value.
 */
const props = withDefaults(
  defineProps<{
    fraction?: number | null
    tone?: 'normal' | 'low' | 'critical'
    label: string
  }>(),
  { fraction: null, tone: 'normal' },
)
const known = computed(
  () => typeof props.fraction === 'number' && Number.isFinite(props.fraction),
)
const pct = computed(() =>
  known.value ? Math.max(0, Math.min(1, props.fraction as number)) * 100 : 0,
)
</script>

<template>
  <span
    v-if="known"
    class="farm-level"
    role="meter"
    :aria-label="label"
    aria-valuemin="0"
    aria-valuemax="100"
    :aria-valuenow="Math.round(pct)"
    :data-tone="tone"
    ><span :style="{ width: pct + '%' }"
  /></span>
  <!-- A meter needs a value: an unknown amount is a labelled picture of an empty track. -->
  <span
    v-else
    class="farm-level"
    role="img"
    :aria-label="`${label}: desconhecido`"
    :data-tone="tone"
    data-unknown="true"
    ><span
  /></span>
</template>

<style>
.farm-level {
  display: block;
  height: 6px;
  min-width: 32px;
  border-radius: 3px;
  background: var(--ops-border);
  overflow: hidden;
}
.farm-level > span {
  display: block;
  height: 100%;
  min-width: 3px;
  border-radius: 3px;
  background: var(--ops-action);
}
.farm-level[data-tone='low'] > span {
  background: var(--ops-attention);
}
.farm-level[data-tone='critical'] > span {
  background: var(--ops-fault);
}
.farm-level[data-unknown] {
  background: repeating-linear-gradient(
    135deg,
    var(--ops-border) 0 3px,
    transparent 3px 6px
  );
}
.farm-level[data-unknown] > span {
  display: none;
}
</style>
