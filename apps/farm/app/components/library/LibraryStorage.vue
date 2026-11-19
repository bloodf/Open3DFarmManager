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
  <section aria-labelledby="library-storage">
    <h2 id="library-storage">Armazenamento</h2>
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
    <ul>
      <li v-for="l in locations" :key="`${l.location}-${l.agentId}`">
        {{ locationLabel(l.location)
        }}<template v-if="l.agentId"> ({{ l.agentId }})</template>:
        {{ l.files }} arquivo(s), {{ formatBytes(l.bytes) }}
      </li>
      <li v-if="!locations.length">Nenhum arquivo guardado ainda.</li>
    </ul>
    <form v-if="canManage" @submit.prevent="next && emit('change-mode', next)">
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
