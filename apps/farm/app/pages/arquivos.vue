<script setup lang="ts">
import { useFarmRoute } from '../composables/useFarmRoute.ts'
import { formatNumber } from '../utils/ui-format.ts'
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from 'vue'
import Button from '../components/ui/Button.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import ErrorState from '../components/ui/ErrorState.vue'
import Skeleton from '../components/ui/Skeleton.vue'
import StaleNotice from '../components/ui/StaleNotice.vue'
import { useFarmView } from '../composables/useFarmView.ts'
import {
  filesAvailability,
  printableEntry,
  printableFile,
  validateUpload,
} from '../utils/files-view.ts'
import {
  createFilesSession,
  type FilesState,
  type PrinterFile,
} from '../utils/files-view-session.ts'
import {
  openFarmPauseControl,
  type FarmPauseControl,
} from '../utils/webrtc/farm-pause-control.ts'
import { createFarmStatusKeyResolver } from '../utils/webrtc/farm-status-key-resolver.ts'

const { route, setFarmScope } = useFarmRoute()
const { state, ready, now, discover, selectFarm, selectKey } = useFarmView({
  requestedFarm: () => route.query.farm,
})

const printer = ref('')
const files = shallowRef<PrinterFile[]>([])
const selected = ref('')
const selectedPrintable = computed(() =>
  files.value.some(
    (file) => file.name === selected.value && printableEntry(file),
  ),
)
const upload = shallowRef<File | null>(null)
const operation = shallowRef<FilesState>({ kind: 'idle' })
const enabled = ref(false)
const confirmed = ref(false)
// Listing unsupported: the name of a file already stored on the printer.
const manualEntry = ref(false)
const manualName = ref('')
const metadataAbort = new AbortController()
onMounted(async () => {
  try {
    const metadata = await $fetch<unknown>('/api/signalling/pause-metadata', {
      signal: metadataAbort.signal,
      retry: 0,
      timeout: 10_000,
      cache: 'no-store',
    })
    enabled.value =
      !!metadata &&
      typeof metadata === 'object' &&
      'enabled' in metadata &&
      metadata.enabled === true &&
      'origin' in metadata &&
      metadata.origin === location.origin
  } catch {
    enabled.value = false
  }
})
const row = computed(() =>
  ready.value?.rows.find(
    (item) => item.assignment.assignmentId === printer.value,
  ),
)
// Reads the once-a-second tick for reactivity, but measures against a fresh
// sample: a frame received after the last tick would otherwise have a negative
// age, count as stale and cancel the operation in progress.
const availability = computed(() => {
  void now.value
  return row.value && ready.value
    ? filesAvailability(row.value, ready.value.keys, enabled.value, {
        wall: Date.now(),
        mono: performance.now(),
      })
    : {
        available: false as const,
        reason: 'Selecione uma impressora com conexão direta ao vivo.',
      }
})
const busy = computed(() =>
  ['loading', 'preparing', 'uploading', 'starting'].includes(
    operation.value.kind,
  ),
)
const message = computed(() => {
  const value = operation.value
  switch (value.kind) {
    case 'idle':
      return ''
    case 'loading':
      return 'Preparando conexão direta e autorização…'
    case 'preparing':
      return 'Verificando o arquivo antes do envio…'
    case 'uploading':
      return `Enviando arquivo: ${Math.floor((value.sent / value.total) * 100)}%.`
    case 'starting':
      return 'Enviando comando para iniciar impressão…'
    default:
      return value.message
  }
})
const resolver = createFarmStatusKeyResolver({
  readMetadata: (signal) =>
    $fetch<unknown>('/api/signalling/pause-metadata', {
      signal,
      retry: 0,
      timeout: 10_000,
      cache: 'no-store',
    }),
  isCurrent(scope, keyId) {
    const current = ready.value
    return (
      !!current &&
      current.accountId === scope.accountId &&
      current.scope?.accountId === scope.accountId &&
      current.scope.farmId === scope.farmId &&
      current.scope.viewEpoch === scope.viewEpoch &&
      current.keys.kind === 'available' &&
      current.keys.selected === keyId
    )
  },
})
async function connect(signal: AbortSignal): Promise<FarmPauseControl> {
  const current = ready.value,
    target = row.value
  if (
    !availability.value.available ||
    !current?.scope ||
    current.keys.kind !== 'available' ||
    !target
  )
    throw Error('Unavailable')
  const scope = current.scope,
    keyId = current.keys.selected
  let control: FarmPauseControl | undefined
  let abort = () => {}
  try {
    await new Promise<void>((resolve, reject) => {
      abort = () => {
        control?.close()
        reject(Error('Cancelled'))
      }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) {
        abort()
        return
      }
      control = openFarmPauseControl({
        accountId: scope.accountId,
        farmId: scope.farmId,
        keyId,
        agentId: target.assignment.agentId,
        assignmentId: target.assignment.assignmentId,
        async resolveKey(keySignal) {
          const key = await resolver({
            scope,
            browserKeyId: keyId,
            signal: keySignal,
          })
          return {
            publicKey: key.localKey.publicKey,
            privateKey: key.localKey.keyPair.privateKey,
            origin: key.origin,
            audience: key.audience,
          }
        },
        onState(value) {
          if (value.kind === 'ready') resolve()
          if (value.kind === 'failed' || value.kind === 'settled')
            reject(Error('Control unavailable'))
        },
      })
    })
    if (!control) throw Error('Unavailable')
    return control
  } catch (error) {
    signal.removeEventListener('abort', abort)
    control?.close()
    await control?.dispose()
    throw error
  }
}
const session = createFilesSession({
  connect,
  available: () => availability.value.available,
  changed: (value) => {
    operation.value = value
  },
  files: (value) => {
    files.value = value
    selected.value = ''
    confirmed.value = false
  },
  listUnsupported: () => {
    manualEntry.value = true
  },
})
function reset() {
  session.cancel()
  files.value = []
  manualEntry.value = false
  manualName.value = ''
  selected.value = ''
  upload.value = null
  confirmed.value = false
}
watch(
  [
    () => ready.value?.scope?.accountId,
    () => ready.value?.scope?.farmId,
    () => ready.value?.scope?.viewEpoch,
    () =>
      ready.value?.keys.kind === 'available' ? ready.value.keys.selected : '',
    printer,
  ],
  reset,
  { flush: 'sync' },
)
watch(
  () => availability.value.available,
  (available) => {
    if (!available) {
      if (operation.value.kind !== 'starting') session.cancel()
      confirmed.value = false
    }
  },
  { flush: 'sync' },
)
watch([selected, manualName], () => {
  confirmed.value = false
})
function chooseFarm(event: Event) {
  if (event.target instanceof HTMLSelectElement)
    setFarmScope(event.target.value)
}
function chooseKey(event: Event) {
  if (event.target instanceof HTMLSelectElement) selectKey(event.target.value)
}
function chooseFile(event: Event) {
  if (!(event.target instanceof HTMLInputElement)) return
  upload.value = event.target.files?.[0] ?? null
  const error = upload.value && validateUpload(upload.value)
  if (error) operation.value = { kind: 'error', message: error }
}
function send() {
  if (row.value && upload.value)
    void session.upload(row.value.assignment.printerKey, upload.value)
}
function list() {
  if (row.value) {
    files.value = []
    selected.value = ''
    void session.list(row.value.assignment.printerKey)
  }
}
function startStored() {
  const name = manualName.value.trim()
  if (!confirmed.value || !manualEntry.value || !printableFile(name)) return
  confirmed.value = false
  void session.start(name)
}
function start() {
  if (!confirmed.value || !selectedPrintable.value) return
  confirmed.value = false
  void session.start(selected.value)
}
// A failed farm read moves focus to the alert so it is announced and reachable.
const errorSummary = ref<HTMLElement | null>(null)
watch(
  () => state.value.kind,
  async (kind) => {
    if (kind !== 'error' && kind !== 'sign-in-required') return
    await nextTick()
    errorSummary.value?.focus()
  },
)
const operationTone = computed(() =>
  operation.value.kind === 'error'
    ? 'error'
    : operation.value.kind === 'done'
      ? 'done'
      : 'info',
)
onBeforeUnmount(() => {
  metadataAbort.abort()
  session.cancel()
})
</script>

<template>
  <main id="conteudo" class="files-page">
    <header class="page-header">
      <p class="eyebrow">Open3DFarmManager</p>
      <h1>Arquivos</h1>
      <p class="intro">
        Envie um arquivo ou escolha um arquivo da impressora para iniciar a
        impressão pela conexão direta.
      </p>
    </header>
    <div v-if="state.kind === 'loading'" aria-busy="true" class="loading panel">
      <p role="status">Carregando farms…</p>
      <Skeleton /><Skeleton /><Skeleton />
    </div>
    <div v-else-if="!ready" ref="errorSummary" role="alert" tabindex="-1">
      <ErrorState
        title="Arquivos indisponíveis"
        :description="
          state.kind === 'sign-in-required'
            ? 'Sua sessão não está ativa. Entre novamente para ver suas farms.'
            : 'Não foi possível carregar suas farms. Tente novamente.'
        "
      >
        <div class="actions">
          <Button @click="discover()">Tentar novamente</Button>
          <NuxtLink to="/entrar">Entrar</NuxtLink>
        </div>
      </ErrorState>
    </div>
    <template v-else>
      <section class="panel" aria-labelledby="files-target-title">
        <h2 id="files-target-title">Destino</h2>
        <div class="field-grid">
          <div class="field">
            <label for="files-farm">Farm</label>
            <select
              id="files-farm"
              :value="ready.scope?.farmId ?? ''"
              :disabled="busy"
              @change="chooseFarm"
            >
              <option value="">Selecione uma farm</option>
              <option
                v-for="farm in ready.farms"
                :key="farm.farmId"
                :value="farm.farmId"
              >
                {{ farm.farmId }}
              </option>
            </select>
          </div>
          <div
            class="field"
            v-if="ready.scope && ready.keys.kind === 'available'"
          >
            <label for="files-key">Dispositivo aprovado deste navegador</label>
            <select
              id="files-key"
              :value="ready.keys.selected"
              :disabled="busy"
              @change="chooseKey"
            >
              <option value="">Selecione um dispositivo</option>
              <option
                v-for="key in ready.keys.choices"
                :key="key.keyId"
                :value="key.keyId"
              >
                {{ key.keyId }}
              </option>
            </select>
          </div>
          <div class="field" v-if="ready.scope">
            <label for="files-printer">Impressora</label>
            <select
              id="files-printer"
              v-model="printer"
              :disabled="busy || ready.inventory === 'loading'"
            >
              <option value="">Selecione uma impressora</option>
              <option
                v-for="item in ready.rows"
                :key="item.assignment.assignmentId"
                :value="item.assignment.assignmentId"
              >
                {{ item.assignment.printerKey }}
              </option>
            </select>
          </div>
        </div>
        <div v-if="ready.farmAfter || ready.nextFarm" class="actions">
          <Button v-if="ready.farmAfter" :disabled="busy" @click="discover()">
            Primeira página de farms
          </Button>
          <Button
            v-if="ready.nextFarm"
            :disabled="busy"
            @click="discover(ready.nextFarm)"
          >
            Próximas farms
          </Button>
        </div>
        <EmptyState
          v-if="!ready.farms.length"
          title="Nenhuma farm nesta página"
          description="Esta conta ainda não tem uma farm aqui. Crie uma farm ou volte à primeira página."
        >
          <NuxtLink to="/farm">Ir para farms</NuxtLink>
        </EmptyState>
        <template v-if="ready.scope">
          <p v-if="ready.keys.kind !== 'available'" role="status" class="note">
            É necessário um dispositivo aprovado deste navegador.
            <NuxtLink to="/dispositivos">Gerenciar dispositivos</NuxtLink>
          </p>
          <p v-if="row" class="note">
            Impressora selecionada: {{ row.assignment.printerKey }}
          </p>
          <div
            v-if="ready.inventory === 'loading'"
            aria-busy="true"
            class="loading"
          >
            <p role="status">Carregando impressoras…</p>
            <Skeleton /><Skeleton />
          </div>
          <EmptyState
            v-else-if="!ready.rows.length"
            title="Nenhuma impressora nesta página"
            description="Adicione uma impressora a esta farm para enviar arquivos."
          >
            <NuxtLink to="/impressoras">Ir para impressoras</NuxtLink>
          </EmptyState>
          <div v-if="ready.printerAfter || ready.nextPrinter" class="actions">
            <Button
              v-if="ready.printerAfter"
              :disabled="busy"
              @click="selectFarm(ready.scope.farmId)"
            >
              Primeira página de impressoras
            </Button>
            <Button
              v-if="ready.nextPrinter"
              :disabled="busy"
              @click="selectFarm(ready.scope.farmId, ready.nextPrinter)"
            >
              Próximas impressoras
            </Button>
          </div>
        </template>
      </section>
      <template v-if="ready.scope">
        <StaleNotice
          v-if="!availability.available"
          id="files-unavailable"
          title="Conexão direta indisponível"
          :description="`${availability.reason} O modo degradado permite somente leitura.`"
        />
        <section class="panel" aria-labelledby="upload-title" :aria-busy="busy">
          <h2 id="upload-title">Enviar arquivo</h2>
          <form class="stack" @submit.prevent="send">
            <div class="field">
              <label for="files-upload"
                >Arquivo .gcode ou .3mf (até 512 MiB)</label
              >
              <input
                id="files-upload"
                type="file"
                accept=".gcode,.3mf"
                :disabled="busy || !availability.available"
                @change="chooseFile"
              />
            </div>
            <div class="actions">
              <Button
                type="submit"
                :disabled="
                  busy ||
                  !availability.available ||
                  !upload ||
                  !!validateUpload(upload)
                "
              >
                Enviar arquivo
              </Button>
            </div>
          </form>
          <progress
            v-if="operation.kind === 'uploading'"
            :value="operation.sent"
            :max="operation.total"
            aria-label="Progresso do envio"
          />
        </section>
        <section class="panel" aria-labelledby="list-title">
          <h2 id="list-title">Arquivos da impressora</h2>
          <div class="actions">
            <Button :disabled="busy || !availability.available" @click="list">
              Consultar arquivos
            </Button>
          </div>
          <EmptyState
            v-if="!files.length"
            :level="3"
            title="Nenhum arquivo listado"
            description="Consulte os arquivos da impressora ou envie um arquivo."
          />
          <ul
            v-if="files.some((file) => file.thumbnail)"
            class="thumbs"
            aria-label="Miniaturas dos arquivos"
          >
            <li
              v-for="file in files.filter((item) => item.thumbnail)"
              :key="file.name"
            >
              <img
                :src="`data:image/png;base64,${file.thumbnail}`"
                alt=""
                width="96"
                height="96"
              />
              <span>{{ file.name }}</span>
            </li>
          </ul>
          <form
            v-if="manualEntry && !files.length"
            class="stack"
            @submit.prevent="startStored"
          >
            <p class="note">
              Listagem não suportada pela biblioteca desta impressora. Informe o
              nome exato de um arquivo .gcode já armazenado na impressora.
            </p>
            <div class="field">
              <label for="files-stored">Arquivo armazenado na impressora</label>
              <input
                aria-describedby="files-stored-error"
                :aria-invalid="
                  !!manualName.trim() && !printableFile(manualName.trim())
                "
                id="files-stored"
                v-model="manualName"
                type="text"
                maxlength="255"
                autocomplete="off"
                spellcheck="false"
                :disabled="busy"
              />
              <span
                v-if="manualName.trim() && !printableFile(manualName.trim())"
                id="files-stored-error"
                class="field-error"
                >Nome inválido para o comando de impressão.</span
              >
            </div>
            <label class="confirmation"
              ><input
                v-model="confirmed"
                type="checkbox"
                :disabled="
                  busy ||
                  !availability.available ||
                  !printableFile(manualName.trim())
                "
              /><span
                >Conferi o arquivo {{ manualName.trim() || 'informado' }} e a
                impressora {{ row?.assignment.printerKey }}. Quero iniciar esta
                impressão.</span
              ></label
            >
            <div class="actions">
              <Button
                type="submit"
                :disabled="
                  busy ||
                  !availability.available ||
                  !printableFile(manualName.trim()) ||
                  !confirmed
                "
              >
                Iniciar impressão
              </Button>
            </div>
          </form>
          <form v-if="files.length" class="stack" @submit.prevent="start">
            <div class="field">
              <label for="files-existing">Arquivo para imprimir</label>
              <select
                aria-describedby="files-existing-hint"
                id="files-existing"
                v-model="selected"
                :disabled="busy"
              >
                <option value="">Selecione um arquivo</option>
                <option
                  v-for="file in files"
                  :key="file.name"
                  :value="file.name"
                  :disabled="!printableEntry(file)"
                >
                  {{ file.name }} ({{ formatNumber(file.size) }} bytes){{
                    file.printUnsupported ? ' · Impressão indisponível' : ''
                  }}
                </option>
              </select>
              <span id="files-existing-hint" class="hint"
                >Selecione um arquivo habilitado para impressão.</span
              >
            </div>
            <label class="confirmation"
              ><input
                v-model="confirmed"
                type="checkbox"
                :disabled="
                  busy || !selectedPrintable || !availability.available
                "
              /><span
                >Conferi o arquivo {{ selected || 'selecionado' }} e a
                impressora {{ row?.assignment.printerKey }}. Quero iniciar esta
                impressão.</span
              ></label
            >
            <div class="actions">
              <Button
                type="submit"
                :disabled="
                  busy ||
                  !availability.available ||
                  !selectedPrintable ||
                  !confirmed
                "
              >
                Iniciar impressão
              </Button>
            </div>
          </form>
        </section>
      </template>
    </template>
    <div
      class="operation"
      :class="[
        operationTone,
        { active: message || (busy && operation.kind !== 'starting') },
      ]"
    >
      <p role="status" aria-live="polite">{{ message }}</p>
      <Button
        v-if="busy && operation.kind !== 'starting'"
        @click="session.cancel()"
      >
        Cancelar operação
      </Button>
    </div>
  </main>
</template>

<style scoped>
.files-page {
  display: grid;
  gap: var(--space-4);
  align-content: start;
  max-width: 52rem;
  overflow-wrap: anywhere;
}
.page-header {
  display: grid;
  gap: var(--space-2);
}
.eyebrow {
  margin: 0;
  font-size: var(--font-size-sm);
  letter-spacing: 0.04em;
  color: var(--color-text-muted);
}
.page-header h1 {
  margin: 0;
}
.intro,
.note {
  margin: 0;
  color: var(--color-text-muted);
}
.panel {
  display: grid;
  gap: var(--space-3);
  margin: 0;
  padding: var(--space-5);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  min-width: 0;
}
.panel > * {
  min-width: 0;
}
h2 {
  margin: 0;
  font-size: var(--font-size-lg);
  line-height: var(--line-height-tight);
}
.field-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr));
  gap: var(--space-3) var(--space-4);
}
.field {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
}
label {
  font-weight: var(--font-weight-semibold);
}
.hint {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}
.field-error {
  font-size: var(--font-size-sm);
  color: var(--state-error-color);
}
.stack {
  display: grid;
  gap: var(--space-3);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
  align-items: center;
}
.loading {
  display: grid;
  gap: var(--space-3);
}
.loading p {
  margin: 0;
}
select,
input[type='text'],
input[type='file'] {
  width: 100%;
  min-height: 2.75rem;
  min-width: 0;
  padding: var(--space-2) var(--space-3);
  font: inherit;
  color: inherit;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}
input[type='file'] {
  padding: var(--space-2);
}
select:disabled,
input:disabled {
  opacity: 0.6;
}
:is(select, input):focus-visible,
a:focus-visible,
[role='alert']:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.confirmation {
  font-weight: normal;
  display: flex;
  gap: var(--space-3);
  align-items: flex-start;
}
.confirmation input {
  flex: none;
  inline-size: 1.5rem;
  block-size: 1.5rem;
  margin: 0.1rem 0 0;
  accent-color: var(--color-accent);
}
progress {
  width: 100%;
  accent-color: var(--color-accent);
}
.thumbs {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 8rem), 1fr));
  gap: var(--space-3);
}
.thumbs li {
  display: grid;
  gap: var(--space-2);
  justify-items: center;
  text-align: center;
  font-size: var(--font-size-sm);
}
.thumbs img {
  object-fit: contain;
  max-inline-size: 100%;
  border-radius: var(--radius-sm);
  background: var(--color-surface);
}
.operation:not(.active) {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
.operation.active {
  position: sticky;
  inset-block-end: var(--space-3);
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
  align-items: center;
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  box-shadow: var(--elevation-2);
}
.operation.error.active {
  border-color: var(--state-error-color);
}
.operation p {
  margin: 0;
  flex: 1 1 14rem;
}
.files-page :deep(.stale strong) {
  display: block;
}
/* Same bordered surface as the panels. */
.files-page :deep(.ui-card) {
  border: 1px solid var(--color-border);
  box-shadow: none;
}
@media (max-width: 30rem) {
  .panel {
    padding: var(--space-4);
  }
}
</style>
