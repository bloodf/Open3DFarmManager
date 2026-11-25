<script setup lang="ts">
import { computed, ref } from 'vue'
import Button from '../ui/Button.vue'
import Field from '../ui/Field.vue'
import ProgressBar from '../ui/ProgressBar.vue'
import {
  formatBytes,
  locationLabel,
  uploadFile,
  validateLibraryUpload,
  type LibraryVersion,
  type StorageMode,
} from '../../utils/library-view.ts'
import LibraryMetadata from './LibraryMetadata.vue'

const props = defineProps<{
  farmId: string
  mode: StorageMode
  /** Approved Connectors; the file goes to one of them in Connector mode. */
  connectors: readonly { agentId: string }[]
  /** Adds a version to this item instead of creating one. */
  itemId?: string
}>()
const emit = defineEmits<{ (e: 'uploaded', version: LibraryVersion): void }>()

const file = ref<File | null>(null)
const title = ref('')
const tags = ref('')
const notes = ref('')
const agentId = ref('')
const progress = ref(0)
const busy = ref(false)
const error = ref('')
const result = ref<{ version: LibraryVersion; deduplicated: boolean } | null>(
  null,
)
const needsConnector = computed(() => props.mode === 'connector')
const connectorError = computed(() =>
  error.value.startsWith('Escolha o Connector') ? error.value : undefined,
)
const fileError = computed(() =>
  connectorError.value ? undefined : error.value,
)

function pick(event: Event) {
  const picked = (event.target as HTMLInputElement).files?.[0] ?? null
  file.value = picked
  result.value = null
  error.value = picked ? (validateLibraryUpload(picked) ?? '') : ''
}

async function submit() {
  if (busy.value) return
  result.value = null
  if (!file.value) {
    error.value = 'Selecione um arquivo .gcode ou .3mf.'
    return
  }
  error.value = validateLibraryUpload(file.value) ?? ''
  if (!error.value && needsConnector.value && !agentId.value)
    error.value = 'Escolha o Connector que vai guardar o arquivo.'
  if (error.value) return
  busy.value = true
  progress.value = 0
  try {
    result.value = await uploadFile(
      {
        farmId: props.farmId,
        file: file.value,
        title: title.value,
        notes: notes.value,
        tags: tags.value
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
        ...(props.itemId ? { itemId: props.itemId } : {}),
        ...(needsConnector.value ? { agentId: agentId.value } : {}),
      },
      (fraction) => (progress.value = Math.round(fraction * 100)),
    )
    emit('uploaded', result.value.version)
  } catch (cause) {
    error.value =
      cause instanceof Error && cause.message === 'Envio cancelado.'
        ? cause.message
        : 'Não foi possível enviar o arquivo. Tente novamente.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <form class="upload" novalidate @submit.prevent="submit">
    <Field label="Arquivo (.gcode ou .3mf, até 512 MiB)" :error="fileError">
      <template #default="{ control }">
        <input
          v-bind="control"
          type="file"
          accept=".gcode,.3mf"
          :disabled="busy"
          @change="pick"
        />
      </template>
    </Field>
    <p v-if="file" class="selected">
      {{ file.name }}, {{ formatBytes(file.size) }}. Será guardado em:
      {{ locationLabel(mode) }}.
    </p>
    <Field v-if="!itemId" label="Título (opcional)">
      <template #default="{ control }">
        <input
          v-bind="control"
          v-model="title"
          type="text"
          maxlength="200"
          :disabled="busy"
        />
      </template>
    </Field>
    <Field v-if="!itemId" label="Etiquetas" hint="Separe por vírgulas.">
      <template #default="{ control }">
        <input v-bind="control" v-model="tags" type="text" :disabled="busy" />
      </template>
    </Field>
    <Field label="Notas (opcional)">
      <template #default="{ control }">
        <input
          v-bind="control"
          v-model="notes"
          type="text"
          maxlength="2000"
          :disabled="busy"
        />
      </template>
    </Field>
    <Field
      v-if="needsConnector"
      label="Connector de destino"
      :error="connectorError"
    >
      <template #default="{ control }">
        <select v-bind="control" v-model="agentId" :disabled="busy">
          <option value="">Escolha um Connector</option>
          <option v-for="c in connectors" :key="c.agentId" :value="c.agentId">
            {{ c.agentId }}
          </option>
        </select>
      </template>
    </Field>
    <ProgressBar v-if="busy" label="Progresso do envio" :value="progress" />
    <Button type="submit" class="ops-primary send" :disabled="busy">
      {{ busy ? 'Enviando…' : 'Enviar para a biblioteca' }}
    </Button>
    <section
      v-if="result"
      class="result"
      aria-labelledby="upload-preview"
      role="status"
    >
      <h3 id="upload-preview">
        Arquivo enviado: versão {{ result.version.versionNumber }}
      </h3>
      <p v-if="result.deduplicated">
        O mesmo conteúdo já estava guardado; esta versão apenas o referencia.
      </p>
      <p>{{ result.version.plateCount }} placa(s) no arquivo.</p>
      <LibraryMetadata :metadata="result.version.metadata" />
    </section>
  </form>
</template>

<style scoped>
.upload {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-3);
}
.upload > * {
  min-width: 0;
}
.upload :deep(.field) {
  grid-template-columns: minmax(0, 1fr);
}
.upload :deep(input),
.upload :deep(select) {
  max-width: 100%;
  min-width: 0;
}
.selected {
  margin: 0;
  color: var(--ops-muted);
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.send {
  justify-self: start;
}
.upload :deep(.field span) {
  color: var(--ops-muted);
  font-size: var(--ops-text-small);
}
.upload :deep(.field span.error) {
  color: var(--ops-fault);
}
.upload :deep(progress) {
  accent-color: var(--ops-action);
}
.result {
  display: grid;
  gap: var(--ops-space-2);
  padding: var(--ops-space-3);
  border: 1px solid var(--ops-action);
  border-radius: var(--ops-radius-lg);
  background: var(--ops-raised);
}
.result > :is(h3, p) {
  margin: 0;
}
</style>
