<script setup lang="ts">
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 bloodf
// Ported from bloodf/orca-ui-foundation src/components/OuiSlot.vue @ e4d93af0cf576660ad4b80ac5d5a1cdef4a5c795
// (MIT, see THIRD_PARTY_NOTICES.md). Changes: OpenFarm --ops-* tokens, pt-BR copy, the level comes from
// resolveSpoolLevel (Spoolman weights, then the printer percentage, else unknown), and a missing colour is stated in text.
import { computed } from 'vue'
import { resolveSpoolLevel } from '../../utils/spool-level.ts'
import { formatPercentage, formatWeight } from '../../utils/ui-format.ts'
import FarmLevel from './FarmLevel.vue'
import FarmSpool from './FarmSpool.vue'

/*
 * Where a spool sits on a printer: a toolhead, an AMS or ACE slot, an external holder. A neutral card with a thin strip
 * of the filament's own colour across its top, ringed so black, white and clear still read; the drawn spool shows the
 * same colour at size. The material name is always text: colour is never the only signal. An empty slot has a dashed
 * frame and no strip. A filament without a colour says "Cor não informada" and gets a hatched strip.
 */
const props = withDefaults(
  defineProps<{
    /** The slot's identity, for example "AMS 1 · A2" or "Ferramenta 1". */
    label: string
    name?: string | null
    material?: string | null
    color?: string | null
    colors?: string[] | null
    /** Colour name when known ("Preto"), shown next to the material. */
    colorName?: string | null
    spoolmanRemainingWeight?: number | null
    spoolmanInitialWeight?: number | null
    spoolmanPercent?: number | null
    printerPercent?: number | null
    emptyLabel?: string
    active?: boolean
    low?: boolean
  }>(),
  {
    name: null,
    material: null,
    color: null,
    colors: null,
    colorName: null,
    spoolmanRemainingWeight: null,
    spoolmanInitialWeight: null,
    spoolmanPercent: null,
    printerPercent: null,
    emptyLabel: 'Slot vazio',
    active: false,
    low: false,
  },
)

const empty = computed(() => !props.name && !props.material)
const level = computed(() =>
  resolveSpoolLevel({
    spoolmanRemainingWeight: props.spoolmanRemainingWeight,
    spoolmanInitialWeight: props.spoolmanInitialWeight,
    spoolmanPercent: props.spoolmanPercent,
    printerPercent: props.printerPercent,
  }),
)
const fraction = computed(() =>
  level.value.kind === 'known' ? level.value.fraction : null,
)
const hasColor = computed(() =>
  Boolean(props.color || props.colors?.some(Boolean)),
)
const paint = computed(() => {
  const list = props.colors && props.colors.length > 1 ? props.colors : null
  if (list)
    return (
      'linear-gradient(90deg, ' +
      list
        .map(
          (c, i) =>
            `${c} ${(i * 100) / list.length}% ${((i + 1) * 100) / list.length}%`,
        )
        .join(', ') +
      ')'
    )
  return props.color || props.colors?.[0] || ''
})
const colorText = computed(() =>
  hasColor.value ? props.colorName || null : 'Cor não informada',
)
const meta = computed(() =>
  [props.material, colorText.value].filter(Boolean).join(' · '),
)
const amount = computed(() => {
  const l = level.value
  if (l.kind === 'unknown') return { main: 'Quantidade desconhecida', note: '' }
  const pct = formatPercentage(l.fraction * 100) ?? ''
  if (l.source === 'spoolman') {
    const left = formatWeight(props.spoolmanRemainingWeight)
    const total = formatWeight(props.spoolmanInitialWeight)
    return left && total
      ? { main: `${left} de ${total}`, note: pct }
      : { main: pct, note: 'informado pelo Spoolman' }
  }
  return { main: `${pct} restante`, note: 'informado pela impressora' }
})
</script>

<template>
  <article
    class="farm-slot"
    :data-active="active || undefined"
    :data-empty="empty || undefined"
    :data-level-source="level.kind === 'known' ? level.source : 'unknown'"
  >
    <span
      v-if="!empty"
      class="farm-slot-strip"
      :data-unknown="!paint || undefined"
      :style="paint ? { background: paint } : undefined"
      aria-hidden="true"
    />
    <header class="farm-slot-head">
      <span class="farm-slot-badge">{{ label }}</span>
      <span v-if="$slots.state" class="farm-slot-state"
        ><slot name="state"
      /></span>
    </header>
    <div class="farm-slot-main">
      <FarmSpool
        :color="empty ? null : color"
        :colors="empty ? null : colors"
        :fraction="empty ? 0 : fraction"
        :size="52"
      />
      <div class="farm-slot-id">
        <p class="farm-slot-name" :title="name ?? undefined">
          {{ empty ? emptyLabel : name || material }}
        </p>
        <p v-if="!empty && meta" class="farm-slot-meta">{{ meta }}</p>
      </div>
    </div>
    <div v-if="!empty" class="farm-slot-amount">
      <p class="farm-slot-amount-text">
        <strong>{{ amount.main }}</strong>
        <span v-if="amount.note" class="farm-slot-muted">
          · {{ amount.note }}</span
        >
      </p>
      <FarmLevel
        :fraction="fraction"
        :tone="low ? 'low' : 'normal'"
        label="Filamento restante"
      />
    </div>
    <div v-if="$slots.default" class="farm-slot-extra"><slot /></div>
  </article>
</template>

<style>
.farm-slot {
  display: flex;
  flex-direction: column;
  gap: var(--ops-space-2);
  min-width: 0;
  padding: var(--ops-space-2) var(--ops-space-1);
  border-radius: var(--ops-radius-lg);
  background: var(--ops-raised);
  color: var(--ops-text);
  box-shadow: inset 0 0 0 1px var(--ops-border);
}
.farm-slot[data-active] {
  box-shadow: inset 0 0 0 2px var(--ops-action);
}
.farm-slot[data-empty] {
  background: none;
  box-shadow: none;
  outline: 1.5px dashed var(--ops-border);
  outline-offset: -1.5px;
}
.farm-slot > :not(.farm-slot-strip) {
  padding-inline: 6px;
}
/* The strip: a thin band of the filament's colour inside a hairline ring. Hatched when the colour is not known. */
.farm-slot-strip {
  display: block;
  height: 6px;
  margin: -2px 2px 0;
  border: 1px solid color-mix(in srgb, var(--ops-text) 34%, transparent);
  border-radius: 3px;
  background-clip: padding-box;
}
.farm-slot-strip[data-unknown] {
  background: repeating-linear-gradient(
    135deg,
    transparent 0 4px,
    color-mix(in srgb, var(--ops-muted) 55%, transparent) 4px 5px
  );
}
.farm-slot-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ops-space-2);
  min-height: 22px;
}
.farm-slot-badge {
  padding: 0 var(--ops-space-2);
  border-radius: var(--ops-radius-md);
  background: var(--ops-panel);
  box-shadow: inset 0 0 0 1px var(--ops-border);
  font-size: var(--ops-text-small);
  font-weight: 600;
}
.farm-slot-main {
  display: flex;
  align-items: center;
  gap: var(--ops-space-3);
  min-width: 0;
}
.farm-slot-id {
  display: grid;
  gap: 1px;
  min-width: 0;
}
.farm-slot-id > p,
.farm-slot-amount p {
  margin: 0;
}
.farm-slot-name {
  font-weight: 700;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.farm-slot[data-empty] .farm-slot-name {
  font-weight: 500;
  color: var(--ops-muted);
}
.farm-slot-meta,
.farm-slot-muted {
  color: var(--ops-muted);
  font-size: var(--ops-text-small);
}
.farm-slot-meta {
  overflow-wrap: anywhere;
}
.farm-slot-amount {
  display: grid;
  gap: 5px;
  line-height: 20px;
}
.farm-slot-amount strong {
  font-size: var(--ops-text-body);
  font-weight: 700;
}
.farm-slot-extra {
  display: grid;
  gap: var(--ops-space-2);
}
</style>
