<script setup lang="ts">
import type { ReplaySend } from '../../utils/replay-live.ts'
import { formatDateTime } from '../../utils/ui-format.ts'
import { computed, ref, watch } from 'vue'
import Dialog from '../ui/Dialog.vue'
import Button from '../ui/Button.vue'
import DataTable from '../ui/DataTable.vue'
import ErrorState from '../ui/ErrorState.vue'
import StatusBadge from '../ui/StatusBadge.vue'
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
  replaySend?: ReplaySend
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
type ReplayableVersion = LibraryVersion & { kind: 'gcode' | '3mf' }
const replayVersion = ref<ReplayableVersion>()
const replayItemId = ref('')
const replayPlate = ref(1)
const canReplay = (v: LibraryVersion): v is ReplayableVersion =>
  v.kind !== 'resin' &&
  !!props.replaySend &&
  !!props.replayPrinters &&
  v.deletedAt === null
function replay(v: LibraryVersion) {
  if (!canReplay(v)) return
  replayVersion.value = v
  replayItemId.value = props.item?.id ?? ''
  replayPlate.value = Number(plate.value)
  replaying.value = true
}

async function sendReplay(
  printerKey: string,
  args: LibraryPrintArgs,
  selectionCurrent?: () => boolean,
): Promise<ReplayResult> {
  const versionId = replayVersion.value?.id
  const itemId = replayItemId.value
  const stillSelected = () =>
    props.item?.id === itemId &&
    replayVersion.value?.id === versionId &&
    versions.value.some(
      (entry) =>
        entry.kind !== 'resin' &&
        entry.id === versionId &&
        entry.sha256 === args.sha256 &&
        entry.deletedAt === null &&
        entry.purgedAt === null,
    ) &&
    (selectionCurrent?.() ?? true)
  if (!props.replaySend || !stillSelected())
    return { outcome: 'not-sent', code: 'stale-selection' }
  return props.replaySend(printerKey, args, stillSelected, versionId)
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
/** A removed or deleted file reads as unavailable; the label says which. */
const statusTone = (id: string) => {
  const version = versions.value.find((v) => v.id === id)
  if (version?.purgedAt != null) return 'offline'
  return version?.deletedAt != null ? 'attention' : 'idle'
}
let loadRequest = 0
const rows = computed(() =>
  versions.value.map((v) => ({
    id: v.id,
    cells: {
      number: `v${v.versionNumber}`,
      date: formatDateTime(v.createdAt) ?? 'Indisponível',
      file: v.originalName,
      size: formatBytes(v.sizeBytes),
      where: locationLabel(v.storageLocation),
      status: versionStatus(v),
      actions: '',
    },
  })),
)

async function load() {
  const request = ++loadRequest
  const item = props.item
  const farmId = props.farmId
  if (!item) {
    loading.value = false
    return
  }
  loading.value = true
  error.value = ''
  try {
    const body = await $fetch<{ versions: LibraryVersion[] }>(
      `/api/farms/${farmId}/library/items/${item.id}/versions`,
      { retry: 0, timeout: 15_000 },
    )
    if (
      request !== loadRequest ||
      props.item?.id !== item.id ||
      props.farmId !== farmId
    )
      return
    versions.value = body.versions
    selectedVersion.value = body.versions[0]?.id ?? ''
    plate.value = '1'
  } catch {
    if (
      request !== loadRequest ||
      props.item?.id !== item.id ||
      props.farmId !== farmId
    )
      return
    error.value = 'Não foi possível carregar o histórico de versões.'
  } finally {
    if (request === loadRequest) loading.value = false
  }
}
watch(
  () => [open.value, props.item?.id, props.farmId] as const,
  ([isOpen]) => {
    status.value = ''
    pendingDelete.value = ''
    if (isOpen) void load()
    else {
      loadRequest += 1
      loading.value = false
    }
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
      <p v-if="current.kind === 'resin'" class="note">
        Perfil de impressão informado no envio:
        {{ current.metadata.resinProfile ?? 'não informado' }}.
      </p>
      <p v-else class="note">
        Os metadados abaixo vêm do arquivo da versão v{{
          current.versionNumber
        }}
        e valem para todas as placas.
      </p>
      <LibraryMetadata :metadata="current.metadata" />
      <DataTable
        class="versions"
        caption="Histórico de versões"
        :columns="columns"
        :rows="rows"
      >
        <template #status="{ row }">
          <StatusBadge
            :tone="statusTone(row.id)"
            :label="String(row.cells.status)"
          />
        </template>
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
              <Button class="ops-danger" @click="remove(row.id)"
                >Confirmar exclusão</Button
              >
              <Button @click="pendingDelete = ''">Cancelar</Button>
            </template>
            <Button
              v-else
              class="ops-danger"
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
    :item-id="replayItemId"
    :preferred-plate="replayPlate"
    :source="{
      versionId: replayVersion.id,
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
    :send="sendReplay"
  />
</template>

<style scoped>
.field {
  display: grid;
  gap: var(--ops-space-1);
  max-inline-size: 16rem;
}
.field label {
  font-weight: 600;
}
.note {
  color: var(--ops-muted);
}
.error {
  color: var(--ops-fault);
}
.versions {
  margin-block-start: var(--ops-space-4);
}
.versions :deep(caption) {
  padding-block-end: var(--ops-space-2);
}
.versions :deep(th) {
  color: var(--ops-muted);
  font: 600 var(--ops-text-label) / 16px var(--ops-font-mono);
  text-transform: uppercase;
  white-space: nowrap;
}
.versions :deep(td) {
  vertical-align: top;
  /* The region scrolls sideways, so dates and sizes never split mid-word. */
  overflow-wrap: normal;
  font-variant-numeric: tabular-nums;
}
.versions :deep(.badge) {
  white-space: nowrap;
}
.versions :deep(td .ui-button) {
  margin: 0 var(--ops-space-2) var(--ops-space-2) 0;
  white-space: nowrap;
}
</style>
