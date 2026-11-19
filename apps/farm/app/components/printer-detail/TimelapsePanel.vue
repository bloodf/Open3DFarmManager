<script setup lang="ts">
import { computed } from 'vue'
import Button from '../ui/Button.vue'

const props = defineProps<{
  /** True only when the printer advertises the `timelapse` control. */
  advertised: boolean
  /** Rendered videos from the shared detail session; undefined without data. */
  files?: readonly string[]
  /** A render is running now, as the detail session reports it. */
  rendering?: boolean
  /** False in degraded mode, for a role without access or with a command in flight. */
  canCommand: boolean
  /** True only when the authenticated file-transfer channel is open. */
  canTransfer?: boolean
  /** Why the control is off; the catalog reason when not advertised. */
  disabledReason?: string
  /** Why play and download are off. */
  transferReason?: string
}>()
const emit = defineEmits<{
  (e: 'render', event: Event): void
  (e: 'delete', file: string, event: Event): void
  (e: 'play', file: string, event: Event): void
  (e: 'download', file: string, event: Event): void
}>()

const commandOff = computed(() => !props.canCommand)
const transferOff = computed(() => !props.canTransfer)
const renderOff = computed(() => commandOff.value || props.rendering === true)
</script>

<template>
  <section aria-labelledby="timelapse-title">
    <h2 id="timelapse-title">Timelapse</h2>
    <p v-if="!advertised">
      {{ disabledReason ?? 'Esta impressora não anuncia este recurso.' }}
    </p>
    <template v-else>
      <p v-if="commandOff" id="timelapse-reason">
        {{
          disabledReason ??
          'Indisponível sem conexão direta atual e autorizada.'
        }}
      </p>
      <p v-if="transferOff && transferReason" id="timelapse-transfer-reason">
        {{ transferReason }}
      </p>
      <p role="status" aria-live="polite">
        {{
          rendering
            ? 'Renderização em andamento.'
            : 'Nenhuma renderização em andamento.'
        }}
      </p>
      <div class="timelapse__actions">
        <Button
          type="button"
          :disabled="renderOff"
          :aria-describedby="commandOff ? 'timelapse-reason' : undefined"
          @click="!renderOff && emit('render', $event)"
          >Renderizar timelapse</Button
        >
      </div>
      <p v-if="files === undefined">Sem dados de timelapse neste momento.</p>
      <p v-else-if="!files.length">Nenhum timelapse renderizado.</p>
      <ul v-else class="timelapse__files" aria-label="Timelapses renderizados">
        <li v-for="file in files" :key="file">
          <span class="timelapse__file">{{ file }}</span>
          <Button
            type="button"
            :disabled="transferOff"
            :aria-label="`Reproduzir ${file}`"
            @click="!transferOff && emit('play', file, $event)"
            >Reproduzir</Button
          >
          <Button
            type="button"
            :disabled="transferOff"
            :aria-label="`Baixar ${file}`"
            @click="!transferOff && emit('download', file, $event)"
            >Baixar</Button
          >
          <Button
            type="button"
            :disabled="commandOff"
            :aria-label="`Excluir ${file}`"
            @click="!commandOff && emit('delete', file, $event)"
            >Excluir</Button
          >
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.timelapse__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.timelapse__files {
  display: grid;
  gap: var(--space-2);
  padding-inline-start: var(--space-4);
}
.timelapse__files li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
.timelapse__file {
  flex: 1 1 12rem;
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
