<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import Button from '../ui/Button.vue'

type ConfigFile = { text: string; sha256: string; backups: string[] }
const props = defineProps<{
  reason?: string
  list(signal: AbortSignal): Promise<string[]>
  read(path: string, signal: AbortSignal): Promise<ConfigFile>
  save(
    path: string,
    base: string,
    change: { text: string; restart: boolean } | { backup: string },
    signal: AbortSignal,
  ): Promise<void>
}>()

const files = ref<string[]>([])
const path = ref('')
const loaded = ref<ConfigFile>()
const draft = ref('')
const search = ref('')
const backup = ref('')
const message = ref('')
const busy = ref(false)
const textarea = ref<HTMLTextAreaElement>()
const gutter = ref<HTMLElement>()
const controller = new AbortController()
onBeforeUnmount(() => controller.abort())
const lineNumbers = computed(() =>
  draft.value
    .split('\n')
    .map((_, index) => index + 1)
    .join('\n'),
)
const dirty = computed(
  () => loaded.value !== undefined && loaded.value.text !== draft.value,
)
const unavailable = computed(() => Boolean(props.reason) || busy.value)

async function run(operation: () => Promise<void>) {
  if (unavailable.value) return
  busy.value = true
  message.value = ''
  try {
    await operation()
  } catch (error) {
    if (!controller.signal.aborted)
      message.value =
        error instanceof Error ? error.message : 'A operação falhou.'
  } finally {
    busy.value = false
  }
}

async function load() {
  const file = await props.read(path.value, controller.signal)
  loaded.value = file
  draft.value = file.text
  backup.value = ''
}

function choose(event: Event) {
  const target = event.target as HTMLSelectElement
  if (
    dirty.value &&
    !window.confirm('Descartar as alterações deste arquivo?')
  ) {
    target.value = path.value
    return
  }
  path.value = target.value
  loaded.value = undefined
  if (path.value) void run(load)
}

function save(change: { text: string; restart: boolean } | { backup: string }) {
  const current = loaded.value
  if (!current) return
  void run(async () => {
    await props.save(path.value, current.sha256, change, controller.signal)
    loaded.value = undefined
    message.value =
      'Configuração gravada. Abra o arquivo novamente para continuar.'
  })
}

function find() {
  const editor = textarea.value
  if (!editor || !search.value) return
  const from = editor.selectionEnd
  const next = draft.value.indexOf(search.value, from)
  const index = next < 0 ? draft.value.indexOf(search.value) : next
  if (index < 0) {
    message.value = 'Texto não encontrado.'
    return
  }
  message.value = ''
  editor.focus()
  editor.setSelectionRange(index, index + search.value.length)
}

function syncScroll() {
  if (gutter.value && textarea.value)
    gutter.value.scrollTop = textarea.value.scrollTop
}
</script>

<template>
  <section aria-labelledby="config-editor-heading" :aria-busy="busy">
    <h3 id="config-editor-heading">Configuração do Klipper</h3>
    <p v-if="reason">{{ reason }}</p>
    <fieldset :disabled="unavailable">
      <Button
        type="button"
        @click="
          run(async () => {
            files = await list(controller.signal)
            if (!files.length)
              message = 'Nenhum arquivo de configuração disponível.'
          })
        "
      >
        Listar arquivos
      </Button>
      <label>
        Arquivo de configuração
        <select :value="path" @change="choose">
          <option value="">Selecione um arquivo</option>
          <option v-for="file in files" :key="file" :value="file">
            {{ file }}
          </option>
        </select>
      </label>
      <Button v-if="path && !loaded" type="button" @click="run(load)"
        >Abrir arquivo</Button
      >
      <template v-if="loaded">
        <form @submit.prevent="find">
          <label
            >Buscar no arquivo <input v-model="search" type="search"
          /></label>
          <Button type="submit">Buscar próxima ocorrência</Button>
        </form>
        <label for="klipper-config-content">Conteúdo do arquivo</label>
        <div class="config-source">
          <pre ref="gutter" aria-hidden="true">{{ lineNumbers }}</pre>
          <textarea
            id="klipper-config-content"
            ref="textarea"
            v-model="draft"
            wrap="off"
            spellcheck="false"
            @scroll="syncScroll"
          />
        </div>
        <Button
          type="button"
          :disabled="!dirty"
          @click="save({ text: draft, restart: false })"
          >Salvar</Button
        >
        <Button type="button" @click="save({ text: draft, restart: true })"
          >Salvar e reiniciar</Button
        >
        <label>
          Cópia de segurança
          <select v-model="backup">
            <option value="">Selecione uma cópia</option>
            <option v-for="name in loaded.backups" :key="name" :value="name">
              {{ name }}
            </option>
          </select>
        </label>
        <Button
          type="button"
          :disabled="!backup || dirty"
          @click="save({ backup })"
          >Restaurar</Button
        >
      </template>
    </fieldset>
    <p role="status">{{ busy ? 'Aguarde…' : message }}</p>
  </section>
</template>

<style scoped>
.config-source {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
}

.config-source pre,
.config-source textarea {
  box-sizing: border-box;
  height: 20rem;
  margin: 0;
  padding: 0.5rem;
  border: 1px solid currentColor;
  font: 0.875rem/1.5 monospace;
}

.config-source pre {
  overflow: hidden;
  text-align: right;
  user-select: none;
}

.config-source textarea {
  resize: none;
}
</style>
