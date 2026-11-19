<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { formatDateTime } from '../../utils/ui-format.ts'
import Dialog from '../ui/Dialog.vue'
import Button from '../ui/Button.vue'
import DataTable from '../ui/DataTable.vue'
import ErrorState from '../ui/ErrorState.vue'
import Skeleton from '../ui/Skeleton.vue'
import {
  formatBytes,
  locationLabel,
  versionStatus,
  type LibraryItem,
  type LibraryVersion,
  type StorageMode,
} from '../../utils/library-view.ts'
import LibraryMetadata from './LibraryMetadata.vue'
import LibraryUpload from './LibraryUpload.vue'
import ReplayDialog from './ReplayDialog.vue'
import type { LibraryPrintArgs } from '../../../../../packages/farm-protocol/src/control-actions.ts'
import type { ReplayPrinter, ReplayResult } from '../../utils/replay-view.ts'

const props = defineProps<{
  farmId: string
  item: LibraryItem | null
  canManage: boolean
  canUpload: boolean
  mode: StorageMode
  connectors: readonly { agentId: string }[]
  /** Replay needs a live session: without both props the button is not shown. */
  replayPrinters?: readonly ReplayPrinter[]
  replaySend?: (
    printerKey: string,
    args: LibraryPrintArgs,
  ) => Promise<ReplayResult>
}>()
const emit = defineEmits<{ (e: 'changed'): void }>()
const open = defineModel<boolean>({ required: true })

const versions = ref<LibraryVersion[]>([])
const loading = ref(false)
const error = ref('')
const status = ref('')
const selectedVersion = ref('')
const plate = ref('1')
const pendingDelete = ref('')
const replaying = ref(false)
const replayVersion = ref<LibraryVersion>()
const canReplay = (v: LibraryVersion) =>
  !!props.replaySend && !!props.replayPrinters && v.deletedAt === null
function replay(v: LibraryVersion) {
  replayVersion.value = v
  replaying.value = true
}

const current = computed(
  () =>
    versions.value.find((v) => v.id === selectedVersion.value) ??
    versions.value[0],
)
const columns = [
  { id: 'number', label: 'Versão' },
  { id: 'date', label: 'Enviada em' },
  { id: 'file', label: 'Arquivo' },
  { id: 'size', label: 'Tamanho' },
  { id: 'where', label: 'Guardada em' },
  { id: 'status', label: 'Situação' },
  { id: 'actions', label: 'Ações' },
]
const rows = computed(() =>
  versions.value.map((v) => ({
    id: v.id,
    cells: {
      number: `v${v.versionNumber}`,
      date: formatDateTime(v.createdAt) ?? 'Horário não confirmado',
      file: v.originalName,
      size: formatBytes(v.sizeBytes),
      where: locationLabel(v.storageLocation),
      status: versionStatus(v),
      actions: '',
    },
  })),
)

async function load() {
  if (!props.item) return
  loading.value = true
  error.value = ''
  try {
    const body = await $fetch<{ versions: LibraryVersion[] }>(
      `/api/farms/${props.farmId}/library/items/${props.item.id}/versions`,
      { retry: 0, timeout: 15_000 },
    )
    versions.value = body.versions
    selectedVersion.value = body.versions[0]?.id ?? ''
    plate.value = '1'
  } catch {
    error.value = 'Não foi possível carregar o histórico de versões.'
  } finally {
    loading.value = false
  }
}
watch(
  () => [open.value, props.item?.id] as const,
  ([isOpen]) => {
    status.value = ''
    pendingDelete.value = ''
    if (isOpen) void load()
  },
)

async function remove(id: string) {
  error.value = ''
  try {
    await $fetch(`/api/farms/${props.farmId}/library/versions/${id}`, {
      method: 'DELETE',
      retry: 0,
      timeout: 15_000,
    })
    status.value =
      'Versão excluída. O arquivo é removido após o período de retenção.'
    pendingDelete.value = ''
    emit('changed')
    await load()
  } catch {
    error.value = 'Não foi possível excluir a versão. Tente novamente.'
  }
}
async function uploaded() {
  emit('changed')
  await load()
}
</script>

<template>
  <Dialog v-model="open" :title="item?.title ?? 'Item da biblioteca'">
    <p v-if="status" role="status">{{ status }}</p>
    <p v-if="error && !loading && versions.length" role="alert" class="error">
      {{ error }}
    </p>
    <div v-if="loading" aria-busy="true"><Skeleton /><Skeleton /></div>
    <ErrorState
      v-else-if="error && !versions.length"
      title="Histórico indisponível"
      :description="error"
    >
      <Button @click="load">Tentar novamente</Button>
    </ErrorState>
    <template v-else-if="current">
      <h3>Placa e metadados</h3>
      <div class="field">
        <label for="library-plate">Placa</label>
        <select id="library-plate" v-model="plate">
          <option v-for="n in current.plateCount" :key="n" :value="String(n)">
            Placa {{ n }} de {{ current.plateCount }}
          </option>
        </select>
      </div>
      <p class="note">
        Os metadados abaixo vêm do arquivo da versão v{{
          current.versionNumber
        }}
        e valem para todas as placas.
      </p>
      <LibraryMetadata :metadata="current.metadata" />
      <DataTable caption="Histórico de versões" :columns="columns" :rows="rows">
        <template #actions="{ row }">
          <Button
            v-if="
              versions.find((v) => v.id === row.id) &&
              canReplay(versions.find((v) => v.id === row.id)!)
            "
            :aria-label="`Imprimir de novo a versão ${row.cells.number}`"
            @click="replay(versions.find((v) => v.id === row.id)!)"
            >Imprimir de novo</Button
          >
          <template
            v-if="
              canManage &&
              versions.find((v) => v.id === row.id)?.deletedAt === null
            "
          >
            <template v-if="pendingDelete === row.id">
              <Button @click="remove(row.id)">Confirmar exclusão</Button>
              <Button @click="pendingDelete = ''">Cancelar</Button>
            </template>
            <Button
              v-else
              :aria-label="`Excluir versão ${row.cells.number}`"
              @click="pendingDelete = row.id"
              >Excluir</Button
            >
          </template>
        </template>
      </DataTable>
      <h3>Enviar nova versão</h3>
      <LibraryUpload
        v-if="canUpload"
        :farm-id="farmId"
        :mode="mode"
        :connectors="connectors"
        :item-id="item?.id"
        @uploaded="uploaded"
      />
      <p v-else>Seu papel nesta farm não permite enviar arquivos.</p>
    </template>
  </Dialog>
  <ReplayDialog
    v-if="replayVersion && replayPrinters && replaySend"
    v-model="replaying"
    :source="{
      sha256: replayVersion.sha256,
      name: replayVersion.originalName,
      kind: replayVersion.kind,
      plateCount: replayVersion.plateCount,
      metadata: replayVersion.metadata,
      storageLocation: replayVersion.storageLocation,
      agentId: replayVersion.agentId,
      purged: replayVersion.purgedAt !== null,
    }"
    :printers="replayPrinters"
    :send="replaySend"
  />
</template>

<style scoped>
.field {
  display: grid;
  gap: var(--space-1);
  max-inline-size: 16rem;
}
.note {
  color: var(--text-muted);
}
.error {
  color: var(--printer-error);
}
</style>
