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
            <span
              v-if="safeColour(m.colour)"
              class="swatch"
              :style="{ background: safeColour(m.colour) }"
              aria-hidden="true"
            ></span>
            {{ m.type ?? 'material'
            }}<template v-if="m.colour">, {{ m.colour }}</template>
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
  list-style: none;
  margin: 0;
  padding: 0;
}
.swatch {
  display: inline-block;
  inline-size: 0.875rem;
  block-size: 0.875rem;
  border: 1px solid var(--text-muted);
  border-radius: 50%;
  vertical-align: middle;
}
</style>
