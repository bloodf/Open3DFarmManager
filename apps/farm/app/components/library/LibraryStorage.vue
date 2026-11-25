<script setup lang="ts">
import { ref } from 'vue'
import Button from '../ui/Button.vue'
import {
  formatBytes,
  locationLabel,
  type LibraryLocation,
  type StorageMode,
} from '../../utils/library-view.ts'

defineProps<{
  mode: StorageMode
  quotaBytes: number
  retentionDays: number
  locations: readonly LibraryLocation[]
  usedBytes?: number
  canManage: boolean
}>()
const emit = defineEmits<{ (e: 'change-mode', mode: StorageMode): void }>()
const next = ref<StorageMode | ''>('')
</script>

<template>
  <section class="storage" aria-labelledby="library-storage">
    <h2 id="library-storage" class="ops-title">Armazenamento</h2>
    <p>
      Modo atual: <strong>{{ locationLabel(mode) }}</strong>.
      {{
        mode === 'connector'
          ? 'O servidor não guarda o arquivo; o Connector escolhido o guarda.'
          : 'O servidor guarda os arquivos novos.'
      }}
      Cota: {{ formatBytes(quotaBytes)
      }}<template v-if="usedBytes !== undefined">
        (em uso: {{ formatBytes(usedBytes) }})</template
      >. Versões excluídas ficam {{ retentionDays }} dias antes da remoção.
    </p>
    <h3>Onde estão os arquivos hoje</h3>
    <ul class="locations">
      <li v-for="l in locations" :key="`${l.location}-${l.agentId}`">
        {{ locationLabel(l.location)
        }}<template v-if="l.agentId"> ({{ l.agentId }})</template>:
        {{ l.files }} arquivo(s), {{ formatBytes(l.bytes) }}
      </li>
      <li v-if="!locations.length">Nenhum arquivo guardado ainda.</li>
    </ul>
    <form
      v-if="canManage"
      class="mode"
      @submit.prevent="next && emit('change-mode', next)"
    >
      <label for="library-mode">Modo para novos envios</label>
      <select id="library-mode" v-model="next">
        <option value="">Escolha um modo</option>
        <option value="connector">Connector (padrão)</option>
        <option value="server">Servidor</option>
      </select>
      <Button type="submit" :disabled="!next || next === mode"
        >Alterar modo</Button
      >
      <p>
        A mudança vale só para envios futuros. Os arquivos atuais ficam onde
        estão, sem migração.
      </p>
    </form>
  </section>
</template>

<style scoped>
p {
  margin: 0;
}
h3 {
  margin: 0;
  color: var(--ops-muted);
  font: 600 var(--ops-text-label) / 16px var(--ops-font-mono);
  text-transform: uppercase;
}
.locations {
  margin: 0;
  padding: 0;
  list-style: none;
  font-variant-numeric: tabular-nums;
}
.locations li {
  padding-block: var(--ops-space-2);
  border-block-end: 1px solid var(--ops-border);
  overflow-wrap: anywhere;
}
.mode {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ops-space-2) var(--ops-space-3);
  align-items: center;
}
.mode label {
  font-weight: 600;
}
.mode select {
  flex: 0 1 16rem;
}
.mode p {
  flex-basis: 100%;
  color: var(--ops-muted);
  font-size: var(--ops-text-small);
}
</style>
