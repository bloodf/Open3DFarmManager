<script setup lang="ts">
import { computed } from 'vue'
import {
  filamentColorLabel,
  filamentSwatchBackground,
} from '../../utils/spool-library-format.ts'
import type { FilamentItem } from '../../utils/spool-library-types.ts'

const props = defineProps<{
  filament: Pick<
    FilamentItem,
    'color_hex' | 'multi_color_hexes' | 'multi_color_direction'
  >
  showLabel?: boolean
}>()

const background = computed(() => filamentSwatchBackground(props.filament))
const label = computed(() => filamentColorLabel(props.filament))
</script>

<template>
  <span class="swatch-wrap">
    <span
      class="swatch"
      :class="{ empty: !background }"
      aria-hidden="true"
      :style="background ? { background } : undefined"
    />
    <span v-if="showLabel !== false" class="swatch-label">{{ label }}</span>
  </span>
</template>

<style scoped>
.swatch-wrap {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  max-width: 100%;
}
.swatch {
  flex: none;
  inline-size: 1.125rem;
  block-size: 1.125rem;
  border-radius: 999px;
  border: 1px solid var(--color-text-muted);
}
.swatch.empty {
  background: repeating-linear-gradient(
    -45deg,
    var(--color-surface),
    var(--color-surface) 3px,
    var(--color-border) 3px,
    var(--color-border) 6px
  );
}
.swatch-label {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  overflow-wrap: anywhere;
}
</style>
