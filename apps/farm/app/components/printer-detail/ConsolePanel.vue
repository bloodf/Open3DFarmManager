<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Button from '../ui/Button.vue'
import {
  PRINTING_ALLOW_LIST,
  appendEntries,
  completeCommand,
  lineProblem,
  loadHistory,
  pushHistory,
  saveHistory,
  stepHistory,
  suggestCommands,
  visibleEntries,
  type ConsoleEntry,
} from './console-view.ts'

const props = defineProps<{
  /** True only when the printer advertises the `gcode` control. */
  advertised: boolean
  /** False in degraded mode, without admin scope or with a command in flight. */
  canCommand: boolean
  /** Why the console is off; the catalog reason when not advertised. */
  disabledReason?: string
  printerKey: string
  /** True while printing or paused: only the tuning allow-list is accepted. */
  printing?: boolean
  /** Command names from `printer.gcode.help`, for autocomplete. */
  commands?: readonly string[]
  /** Response batches from `detail.gcode_response`, in arrival order. */
  responses?: readonly { seq: number; lines: readonly string[] }[]
}>()
const emit = defineEmits<{
  (e: 'send-line', line: string, event: Event): void
}>()

const entries = ref<ConsoleEntry[]>([])
const hideTemperature = ref(true)
const line = ref('')
const note = ref('')
const history = ref<string[]>(
  loadHistory(
    typeof localStorage === 'undefined' ? undefined : localStorage,
    props.printerKey,
  ),
)
const cursor = ref(history.value.length)
let lastSeq = -1

watch(
  () => props.responses,
  (batches) => {
    for (const batch of batches ?? []) {
      if (batch.seq <= lastSeq) continue
      lastSeq = batch.seq
      entries.value = appendEntries(entries.value, 'response', batch.lines)
    }
  },
  { immediate: true, deep: true },
)

const shown = computed(() =>
  visibleEntries(entries.value, hideTemperature.value),
)
const suggestions = computed(() =>
  suggestCommands(line.value, props.commands ?? []),
)
const off = computed(() => !props.advertised || !props.canCommand)

function send(event: Event) {
  if (off.value) return
  const problem = lineProblem(line.value)
  note.value = problem ?? ''
  if (problem) return
  const sent = line.value.trim()
  emit('send-line', sent, event)
  entries.value = appendEntries(entries.value, 'command', [sent])
  history.value = pushHistory(history.value, sent)
  saveHistory(
    typeof localStorage === 'undefined' ? undefined : localStorage,
    props.printerKey,
    history.value,
  )
  cursor.value = history.value.length
  line.value = ''
}

function onKey(event: KeyboardEvent) {
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    event.preventDefault()
    const step = stepHistory(
      history.value,
      cursor.value,
      event.key === 'ArrowUp' ? 'up' : 'down',
    )
    cursor.value = step.cursor
    line.value = step.text
  } else if (event.key === 'Tab' && !event.shiftKey) {
    const done = completeCommand(suggestions.value)
    if (done) {
      event.preventDefault()
      line.value = done
    }
  }
}
function clear() {
  entries.value = []
}
</script>

<template>
  <section aria-labelledby="console-title">
    <h2 id="console-title">Console G-code</h2>
    <p v-if="!advertised">
      {{ disabledReason ?? 'Esta impressora não anuncia este recurso.' }}
    </p>
    <template v-else>
      <p v-if="!canCommand" id="console-reason">
        {{
          disabledReason ??
          'Indisponível: apenas administradores podem enviar G-code.'
        }}
      </p>
      <p v-if="printing" id="console-printing">
        Durante a impressão, só são aceitos: {{ PRINTING_ALLOW_LIST }}.
      </p>
      <pre
        class="console__log"
        role="log"
        aria-label="Saída do console"
        aria-live="polite"
        tabindex="0"
      ><template v-for="entry in shown" :key="entry.id"><span :class="`console__${entry.kind}`">{{ entry.kind === 'command' ? '> ' : '' }}{{ entry.text }}</span>
</template></pre>
      <p>
        <label>
          <input v-model="hideTemperature" type="checkbox" />
          Ocultar leituras de temperatura
        </label>
        <Button type="button" @click="clear">Limpar console</Button>
      </p>
      <form class="console__form" @submit.prevent="send($event)">
        <label for="console-line">Comando G-code</label>
        <input
          id="console-line"
          v-model="line"
          type="text"
          autocomplete="off"
          autocapitalize="characters"
          spellcheck="false"
          maxlength="256"
          :disabled="off"
          :aria-describedby="
            [
              !canCommand ? 'console-reason' : '',
              printing ? 'console-printing' : '',
            ]
              .filter(Boolean)
              .join(' ') || undefined
          "
          @keydown="onKey"
        />
        <ul v-if="suggestions.length" aria-label="Sugestões de comando">
          <li v-for="name in suggestions" :key="name">
            <Button type="button" @click="line = `${name} `">{{ name }}</Button>
          </li>
        </ul>
        <Button type="submit" :disabled="off">Enviar</Button>
        <p v-if="note" role="status">{{ note }}</p>
      </form>
      <p>
        Setas para cima e para baixo percorrem o histórico; Tab completa o
        comando.
      </p>
    </template>
  </section>
</template>

<style scoped>
.console__log {
  max-height: 20rem;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  padding: var(--space-2);
  border: 1px solid currentColor;
}
.console__log:focus-visible,
input:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-offset-compact);
}
.console__command {
  font-weight: bold;
}
.console__form {
  display: grid;
  gap: var(--space-2);
  max-width: 32rem;
}
.console__form ul {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  list-style: none;
  padding: 0;
}
input[type='text'] {
  font: inherit;
  min-height: 2.75rem;
  max-width: 100%;
}
</style>
