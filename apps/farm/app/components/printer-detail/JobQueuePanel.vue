<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  QUEUE_OP_MAX_ITEMS,
  QueueOpArguments,
} from '../../../../../packages/farm-protocol/src/control-actions.ts'
import Button from '../ui/Button.vue'

export type QueueJob = { id: string; file: string }

const props = defineProps<{
  /** True only when the printer advertises the `queue_op` control. */
  advertised: boolean
  /** Queue state from the shared detail session; undefined without data. */
  state?: string
  /** Queued jobs in order; undefined until the detail session reports them. */
  jobs?: readonly QueueJob[]
  /** False in degraded mode or with a command in flight: visible but off. */
  canCommand: boolean
  /** Why the control is off; the catalog reason when not advertised. */
  disabledReason?: string
}>()
const emit = defineEmits<{
  (e: 'queue-op', args: QueueOpArguments, event: Event): void
}>()

const STATE_LABELS: Readonly<Record<string, string>> = {
  ready: 'Pronta',
  paused: 'Pausada',
  loading: 'Carregando',
  starting: 'Iniciando',
}
const files = ref('')
const note = ref('')
const disabled = computed(() => !props.canCommand)
const stateText = computed(() =>
  props.state === undefined
    ? 'Sem dados da fila neste momento.'
    : `Estado da fila: ${STATE_LABELS[props.state] ?? 'Desconhecido'}.`,
)

function send(args: unknown, event: Event) {
  if (disabled.value) return
  const parsed = QueueOpArguments.safeParse(args)
  if (!parsed.success) {
    note.value =
      'Informe até ' +
      `${QUEUE_OP_MAX_ITEMS} caminhos de arquivo válidos, sem repetições.`
    return
  }
  note.value = ''
  emit('queue-op', parsed.data, event)
}
function add(event: Event) {
  const names = files.value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  send({ op: 'add', files: names }, event)
}
</script>

<template>
  <section aria-labelledby="queue-title">
    <h2 id="queue-title">Fila de impressão</h2>
    <p v-if="!advertised">
      {{ disabledReason ?? 'Esta impressora não anuncia este recurso.' }}
    </p>
    <template v-else>
      <p v-if="disabled" id="queue-reason">
        {{
          disabledReason ??
          'Indisponível sem conexão direta atual e autorizada.'
        }}
      </p>
      <p role="status" aria-live="polite">{{ stateText }}</p>
      <div class="queue__actions">
        <Button
          type="button"
          :disabled="disabled"
          :aria-describedby="disabled ? 'queue-reason' : undefined"
          @click="send({ op: 'start' }, $event)"
          >Iniciar fila</Button
        >
        <Button
          type="button"
          :disabled="disabled"
          :aria-describedby="disabled ? 'queue-reason' : undefined"
          @click="send({ op: 'pause' }, $event)"
          >Pausar fila</Button
        >
      </div>
      <p v-if="jobs && !jobs.length">A fila está vazia.</p>
      <ol v-else-if="jobs" class="queue__jobs" aria-label="Trabalhos na fila">
        <li v-for="job in jobs" :key="job.id">
          <span class="queue__file">{{ job.file }}</span>
          <Button
            type="button"
            :disabled="disabled"
            :aria-label="`Priorizar ${job.file}`"
            @click="send({ op: 'jump', job_ids: [job.id] }, $event)"
            >Priorizar</Button
          >
          <Button
            type="button"
            :disabled="disabled"
            :aria-label="`Remover ${job.file} da fila`"
            @click="send({ op: 'remove', job_ids: [job.id] }, $event)"
            >Remover</Button
          >
        </li>
      </ol>
      <form class="queue__add" @submit.prevent>
        <label for="queue-files">Arquivos a adicionar</label>
        <textarea
          id="queue-files"
          v-model="files"
          rows="3"
          autocomplete="off"
          spellcheck="false"
          :disabled="disabled"
          aria-describedby="queue-files-hint"
        ></textarea>
        <span id="queue-files-hint">
          Um caminho por linha, relativo à pasta de G-code. Até
          {{ QUEUE_OP_MAX_ITEMS }} arquivos.
        </span>
        <div class="queue__actions">
          <Button type="button" :disabled="disabled" @click="add($event)"
            >Adicionar à fila</Button
          >
        </div>
      </form>
      <p v-if="note" role="status">{{ note }}</p>
    </template>
  </section>
</template>

<style scoped>
.queue__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.queue__jobs {
  display: grid;
  gap: var(--space-2);
  padding-inline-start: var(--space-4);
}
.queue__jobs li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
.queue__file {
  flex: 1 1 12rem;
  min-width: 0;
  overflow-wrap: anywhere;
}
.queue__add {
  display: grid;
  gap: var(--space-2);
  max-width: 32rem;
}
textarea {
  font: inherit;
  max-width: 100%;
}
textarea:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-offset-compact);
}
</style>
