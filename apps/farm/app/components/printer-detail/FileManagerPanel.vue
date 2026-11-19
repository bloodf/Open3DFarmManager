<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, useId, watch } from 'vue'
import { FileOperation } from '../../../../../packages/farm-protocol/src/control-actions.ts'
import { MAX_PRINTER_DOWNLOAD_BYTES } from '../../../../../packages/farm-protocol/src/file-list.ts'
import {
  createFilesSession,
  type FilesState,
  type PrinterFile,
} from '../../utils/files-view-session.ts'
import {
  uploadFile,
  validateLibraryUpload,
  type StorageMode,
} from '../../utils/library-view.ts'
import { printableFile } from '../../utils/files-view.ts'

const props = defineProps<{
  printerKey: string
  farmId: string
  agentId: string
  canSave: boolean
  connect: Parameters<typeof createFilesSession>[0]['connect']
  enabled: boolean
  canEdit: boolean
  canPrint: boolean
}>()
const emit = defineEmits<{
  'file-op': [args: FileOperationInput, event: Event]
  print: [file: string, event: Event]
}>()
type FileOperationInput = ReturnType<typeof FileOperation.parse>

const directory = ref('')
const entries = shallowRef<PrinterFile[]>([])
const status = shallowRef<FilesState>({ kind: 'idle' })
const folder = ref('')
const destination = ref('')
const selected = ref('')
const selectedFile = computed(() =>
  entries.value.find((entry) => entry.name === selected.value),
)
const downloadTooLarge = computed(
  () => (selectedFile.value?.size ?? 0) > MAX_PRINTER_DOWNLOAD_BYTES,
)
const fileGroup = useId()
const library = shallowRef<{ settings: { storageMode: StorageMode } }>()
const libraryAgent = computed(() =>
  library.value?.settings.storageMode === 'connector'
    ? props.agentId
    : undefined,
)
const libraryAvailable = computed(
  () =>
    props.canSave &&
    !!library.value &&
    (library.value.settings.storageMode === 'server' || !!libraryAgent.value),
)
watch(
  () => [props.farmId, props.canSave] as const,
  async ([farmId, canSave], _, onCleanup) => {
    library.value = undefined
    if (!farmId || !canSave) return
    const controller = new AbortController()
    onCleanup(() => controller.abort())
    try {
      const settings = await $fetch<NonNullable<typeof library.value>>(
        `/api/farms/${encodeURIComponent(farmId)}/library/settings`,
        { signal: controller.signal, retry: 0, timeout: 10_000 },
      )
      if (!controller.signal.aborted) library.value = settings
    } catch {
      // Saving is available only when the library settings can be read.
    }
  },
  { immediate: true },
)

const busy = computed(() =>
  ['loading', 'preparing', 'uploading', 'starting'].includes(status.value.kind),
)
const session = createFilesSession({
  connect: (signal) => props.connect(signal),
  available: () => props.enabled,
  changed: (value) => {
    status.value = value
  },
  files: (value) => {
    entries.value = value
  },
})
function browse(path: string) {
  if (!props.enabled || busy.value) return
  directory.value = path
  selected.value = ''
  entries.value = []
  void session.list(props.printerKey, path)
}
function mutate(input: unknown, event: Event) {
  if (!props.enabled || !props.canEdit || busy.value) return
  const args = FileOperation.safeParse(input)
  if (args.success) emit('file-op', args.data, event)
  else
    status.value = {
      kind: 'error',
      message: 'Informe um caminho válido dentro de Arquivos.',
    }
}
function download(save: boolean) {
  if (
    !selected.value ||
    downloadTooLarge.value ||
    busy.value ||
    !props.enabled ||
    (save && !libraryAvailable.value)
  )
    return
  const farmId = props.farmId
  const agentId = libraryAgent.value
  void session.download(props.printerKey, selected.value, async (file) => {
    if (save) {
      if (
        props.farmId !== farmId ||
        !libraryAvailable.value ||
        validateLibraryUpload(file)
      )
        throw Error('Library unavailable')
      await uploadFile(
        {
          farmId,
          file,
          title: '',
          notes: '',
          tags: [],
          ...(agentId ? { agentId } : {}),
        },
        () => {},
      )
      return 'Arquivo salvo na biblioteca.'
    }
    const url = URL.createObjectURL(file)
    const link = document.createElement('a')
    link.href = url
    link.download = file.name
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  })
}
function upload(event: Event) {
  const input = event.currentTarget as HTMLInputElement
  const file = input.files?.[0]
  if (file && props.canPrint) void session.upload(props.printerKey, file)
  input.value = ''
}
watch(
  () => props.enabled,
  (enabled) => {
    if (!enabled) session.cancel()
  },
)
onBeforeUnmount(session.cancel)
</script>

<template>
  <section aria-label="Arquivos da impressora">
    <h2>Arquivos da impressora</h2>
    <p v-if="!enabled">Disponível com conexão direta e autorização.</p>
    <p>{{ directory || 'Pasta principal' }}</p>
    <button
      type="button"
      :disabled="!enabled || busy"
      @click="browse(directory)"
    >
      Atualizar arquivos
    </button>
    <button
      v-if="directory"
      type="button"
      :disabled="!enabled || busy"
      @click="browse(directory.split('/').slice(0, -1).join('/'))"
    >
      Voltar uma pasta
    </button>
    <ul>
      <li v-for="entry in entries" :key="entry.name">
        <button
          v-if="entry.directory"
          type="button"
          :disabled="!enabled || busy"
          @click="browse(entry.name)"
        >
          Abrir {{ entry.name.split('/').at(-1) }}
        </button>
        <template v-else>
          <label>
            <input
              v-model="selected"
              type="radio"
              :name="fileGroup"
              :value="entry.name"
              :disabled="!enabled || busy"
            />
            {{ entry.name.split('/').at(-1) }} ({{ entry.size }} bytes)
          </label>
          <img
            v-if="entry.thumbnail"
            :src="'data:image/png;base64,' + entry.thumbnail"
            alt=""
            width="80"
          />
          <span v-if="entry.estimatedTime !== undefined">
            · {{ Math.ceil(entry.estimatedTime / 60) }} min estimados</span
          >
        </template>
      </li>
    </ul>
    <p>
      <button
        type="button"
        :disabled="!enabled || busy || !selected || downloadTooLarge"
        @click="download(false)"
      >
        Baixar arquivo
      </button>
      <button
        v-if="libraryAvailable"
        type="button"
        :disabled="!enabled || busy || !selected || downloadTooLarge"
        @click="download(true)"
      >
        Salvar na biblioteca
      </button>
    </p>
    <p v-if="downloadTooLarge">
      O arquivo excede o limite de {{ MAX_PRINTER_DOWNLOAD_BYTES / 1024 }} KiB
      para baixar ou salvar na biblioteca.
    </p>
    <fieldset :disabled="!canEdit || !enabled || busy">
      <legend>Organizar arquivos</legend>
      <label
        >Nome da nova pasta <input v-model="folder" maxlength="255"
      /></label>
      <button
        type="button"
        @click="
          mutate(
            {
              op: 'mkdir',
              path: [directory, folder].filter(Boolean).join('/'),
            },
            $event,
          )
        "
        :disabled="!folder"
      >
        Criar pasta
      </button>
      <label
        >Novo caminho do arquivo <input v-model="destination" maxlength="255"
      /></label>
      <button
        type="button"
        :disabled="!selected || !destination"
        @click="mutate({ op: 'move', path: selected, to: destination }, $event)"
      >
        Mover arquivo
      </button>
      <button
        type="button"
        :disabled="!selected"
        @click="mutate({ op: 'delete', path: selected }, $event)"
      >
        Excluir arquivo
      </button>
    </fieldset>
    <fieldset :disabled="!canPrint || !enabled || busy">
      <legend>Impressão</legend>
      <label v-if="!directory"
        >Enviar arquivo
        <input type="file" accept=".gcode,.gco,.g,.3mf" @change="upload"
      /></label>
      <button
        type="button"
        :disabled="!printableFile(selected)"
        @click="emit('print', selected, $event)"
      >
        Iniciar impressão
      </button>
    </fieldset>
    <p role="status">
      {{
        'message' in status
          ? status.message
          : busy
            ? 'Operação em andamento…'
            : ''
      }}
    </p>
  </section>
</template>
