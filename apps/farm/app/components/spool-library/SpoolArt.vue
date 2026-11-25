<script setup lang="ts">
import { computed } from 'vue'
import FarmSpool from '../spool-art/FarmSpool.vue'
import { resolveSpoolLevel, spoolLevelLabel } from '../../utils/spool-level.ts'
import type { SpoolItem } from '../../utils/spool-library-types.ts'

// A spool the library no longer has still draws: the full reel, marked unknown.
const props = withDefaults(
  defineProps<{ spool?: SpoolItem | null; size?: number }>(),
  { spool: null, size: 40 },
)
const fraction = computed(() => {
  const spool = props.spool
  if (!spool) return null
  const level = resolveSpoolLevel({
    spoolmanRemainingWeight: spool.remaining_weight,
    spoolmanInitialWeight: spool.initial_weight ?? spool.filament.weight,
  })
  return level.kind === 'known' ? level.fraction : null
})
const filament = computed(() => props.spool?.filament)
</script>

<template>
  <FarmSpool
    role="img"
    :aria-label="spoolLevelLabel(fraction)"
    :color="filament?.color_hex ? `#${filament.color_hex}` : null"
    :colors="
      filament?.multi_color_hexes
        ?.split(',')
        .filter(Boolean)
        .map((color) => `#${color}`)
    "
    :direction="filament?.multi_color_direction"
    :fraction="fraction"
    :size="size"
  />
</template>
