<script setup lang="ts">
import { formatNumber, formatWeight } from '../../utils/ui-format.ts'
import {
  formatDuration,
  materials,
  nozzles,
  safeColour,
  totalGrams,
  type LibraryMetadata,
} from '../../utils/library-view.ts'
import FarmSpool from '../spool-art/FarmSpool.vue'

defineProps<{ metadata: LibraryMetadata }>()
</script>

<template>
  <dl class="meta">
    <div>
      <dt>Modelo da impressora</dt>
      <dd>{{ metadata.printerModel ?? 'não informado' }}</dd>
    </div>
    <div>
      <dt>Bico</dt>
      <dd class="num">
        {{
          nozzles(metadata).length
            ? nozzles(metadata)
                .map((n) => `${formatNumber(n)} mm`)
                .join(', ')
            : 'não informado'
        }}
      </dd>
    </div>
    <div>
      <dt>Materiais e cores</dt>
      <dd>
        <span v-if="!materials(metadata).length">não informado</span>
        <ul v-else class="materials">
          <li v-for="(m, i) in materials(metadata)" :key="i">
            <FarmSpool
              :color="safeColour(m.colour) ?? null"
              :fraction="1"
              :size="28"
            />
            <span>
              {{ m.type ?? 'Material não informado' }},
              {{ safeColour(m.colour) ?? 'cor não informada' }}</span
            >
          </li>
        </ul>
      </dd>
    </div>
    <div>
      <dt>Tempo estimado</dt>
      <dd class="num">{{ formatDuration(metadata.estimatedTimeSeconds) }}</dd>
    </div>
    <div>
      <dt>Filamento</dt>
      <dd class="num">
        {{ formatWeight(totalGrams(metadata)) ?? 'não informado' }}
      </dd>
    </div>
    <div>
      <dt>Fatiador</dt>
      <dd>
        {{ metadata.slicer ?? 'não informado'
        }}<template v-if="metadata.slicerVersion">
          {{ metadata.slicerVersion }}</template
        >
      </dd>
    </div>
    <div v-if="metadata.layerHeight">
      <dt>Altura de camada</dt>
      <dd class="num">{{ formatNumber(metadata.layerHeight) }} mm</dd>
    </div>
  </dl>
</template>

<style scoped>
.meta {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 10rem), 1fr));
  gap: var(--ops-space-3) var(--ops-space-4);
  margin: 0;
}
dt {
  color: var(--ops-muted);
  font: 600 var(--ops-text-label) / 16px var(--ops-font-mono);
  text-transform: uppercase;
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.num {
  font-family: var(--ops-font-mono);
  font-variant-numeric: tabular-nums;
}
.materials {
  display: grid;
  gap: var(--ops-space-2);
  list-style: none;
  margin: 0;
  padding: 0;
}
.materials li {
  display: flex;
  gap: var(--ops-space-2);
  align-items: center;
}
</style>
