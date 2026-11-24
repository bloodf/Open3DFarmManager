<script setup lang="ts">
import { computed } from 'vue'
import FarmLevel from '../spool-art/FarmLevel.vue'
import FarmSpool from '../spool-art/FarmSpool.vue'
import {
  matchFilament,
  slotPaint,
  type MatchedSlot,
} from '../../utils/filament-match.ts'
import { resolveSpoolLevel } from '../../utils/spool-level.ts'
import { formatPercentage, formatWeight } from '../../utils/ui-format.ts'

/*
 * A filament a file asks for, next to the reel of the slot chosen for it and a
 * sentence saying whether they match. The drawing is decorative: material,
 * colour, amount and the match result are always text. The required filament is
 * drawn full because the file states no level; the slot's level comes from
 * Spoolman weights, then the printer percentage, else "desconhecido".
 */
const props = defineProps<{
  /** 1-based position of the filament in the file. */
  index: number
  required: { type?: string | undefined; colour?: string | undefined }
  matched?: MatchedSlot | null | undefined
}>()

const result = computed(() =>
  matchFilament(props.required, props.matched ?? null),
)
const wantPaint = computed(() => slotPaint(props.required.colour) ?? null)
const havePaint = computed(() => slotPaint(props.matched?.colorHex) ?? null)
const level = computed(() =>
  resolveSpoolLevel({
    spoolmanRemainingWeight: props.matched?.spoolmanRemainingWeight ?? null,
    spoolmanInitialWeight: props.matched?.spoolmanInitialWeight ?? null,
    printerPercent: props.matched?.remainingPercent ?? null,
  }),
)
const fraction = computed(() =>
  level.value.kind === 'known' ? level.value.fraction : null,
)
const amount = computed(() => {
  const l = level.value
  if (l.kind === 'unknown') return 'Quantidade desconhecida'
  const pct = formatPercentage(l.fraction * 100) ?? ''
  if (l.source === 'spoolman') {
    const left = formatWeight(props.matched?.spoolmanRemainingWeight)
    const total = formatWeight(props.matched?.spoolmanInitialWeight)
    return `${left} de ${total} (${pct})`
  }
  return `${pct}, informado pela impressora`
})
</script>

<template>
  <div class="filament-match" :data-tone="result.tone" :data-kind="result.kind">
    <div class="side" data-side="required">
      <FarmSpool :color="wantPaint" :fraction="1" :size="44" />
      <p class="what">
        <span class="role">Filamento {{ index }} do arquivo</span>
        <strong>{{ required.type ?? 'Material não informado' }}</strong>
        <span>{{ wantPaint ?? 'Cor não informada' }}</span>
      </p>
    </div>
    <div v-if="matched" class="side" data-side="slot">
      <FarmSpool :color="havePaint" :fraction="fraction" :size="44" />
      <p class="what">
        <span class="role">{{ matched.label }}</span>
        <strong>{{ matched.materialType ?? 'Material não informado' }}</strong>
        <span>{{ havePaint ? `Cor ${havePaint}` : 'Cor não informada' }}</span>
        <FarmLevel
          :fraction="fraction"
          :label="`Quantidade restante no ${matched.label}`"
        />
        <span>{{ amount }}</span>
      </p>
    </div>
    <p class="result" data-result aria-live="polite">{{ result.text }}</p>
  </div>
</template>

<style scoped>
.filament-match {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr));
  gap: var(--ops-space-3);
  padding: var(--ops-space-3);
  border: 1px solid var(--ops-border);
  border-inline-start: 4px solid var(--ops-muted);
  border-radius: var(--ops-radius-lg);
  background: var(--ops-panel);
  color: var(--ops-text);
  font-size: var(--ops-text-body);
}
.filament-match[data-tone='ok'] {
  border-inline-start-color: var(--ops-action);
}
.filament-match[data-tone='warn'] {
  border-inline-start-color: var(--ops-attention);
}
.side {
  display: flex;
  gap: var(--ops-space-3);
  align-items: flex-start;
  min-inline-size: 0;
}
.what {
  display: grid;
  gap: var(--ops-space-1);
  margin: 0;
  min-inline-size: 0;
  overflow-wrap: anywhere;
}
.role {
  color: var(--ops-muted);
  font-size: var(--ops-text-small);
}
.result {
  grid-column: 1 / -1;
  margin: 0;
  font-weight: 600;
}
.filament-match[data-tone='warn'] .result {
  color: var(--ops-attention);
}
</style>
