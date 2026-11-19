<script setup lang="ts">
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
      <dd>
        {{
          nozzles(metadata).length
            ? nozzles(metadata)
                .map((n) => `${String(n).replace('.', ',')} mm`)
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
      <dd>{{ formatDuration(metadata.estimatedTimeSeconds) }}</dd>
    </div>
    <div>
      <dt>Filamento</dt>
      <dd>
        {{
          totalGrams(metadata) === undefined
            ? 'não informado'
            : `${String(totalGrams(metadata)).replace('.', ',')} g`
        }}
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
      <dd>{{ String(metadata.layerHeight).replace('.', ',') }} mm</dd>
    </div>
  </dl>
</template>

<style scoped>
.meta {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  gap: var(--space-2) var(--space-4);
  margin: 0;
}
dt {
  font-size: var(--type-small);
  color: var(--text-muted);
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
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
