<script setup lang="ts">
import FarmSpool from '../spool-art/FarmSpool.vue'
import { resolveSpoolLevel } from '../../utils/spool-level.ts'
import type { SpoolItem } from '../../utils/spool-library-types.ts'

const props = withDefaults(defineProps<{ spool: SpoolItem; size?: number }>(), {
  size: 40,
})
const fraction = (spool: SpoolItem) => {
  const level = resolveSpoolLevel({
    spoolmanRemainingWeight: spool.remaining_weight,
    spoolmanInitialWeight: spool.initial_weight ?? spool.filament.weight,
  })
  return level.kind === 'known' ? level.fraction : null
}
</script>

<template>
  <FarmSpool
    :color="spool.filament.color_hex ? `#${spool.filament.color_hex}` : null"
    :colors="
      spool.filament.multi_color_hexes
        ?.split(',')
        .filter(Boolean)
        .map((color) => `#${color}`)
    "
    :direction="spool.filament.multi_color_direction"
    :fraction="fraction(spool)"
    :size="size"
  />
</template>
