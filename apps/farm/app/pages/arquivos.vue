<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from 'vue'
import { useFarmView } from '../composables/useFarmView.ts'
import {
  filesAvailability,
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

definePageMeta({ middleware: 'farm-flag' })
const { state, ready, now, discover, selectFarm, selectKey } = useFarmView()
const printer = ref('')
const files = shallowRef<PrinterFile[]>([])
const selected = ref('')
const upload = shallowRef<File | null>(null)
const operation = shallowRef<FilesState>({ kind: 'idle' })
const enabled = ref(false)
const confirmed = ref(false)
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
const availability = computed(() =>
  row.value && ready.value
    ? filesAvailability(row.value, ready.value.keys, enabled.value, now.value)
    : {
        available: false as const,
        reason: 'Selecione uma impressora com conexão direta ao vivo.',
      },
)
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
})
function reset() {
  session.cancel()
  files.value = []
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
watch(selected, () => {
  confirmed.value = false
})
function chooseFarm(event: Event) {
  if (event.target instanceof HTMLSelectElement)
    void selectFarm(event.target.value)
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
function start() {
  if (
    !confirmed.value ||
    !files.value.some((file) => file.name === selected.value)
  )
    return
  confirmed.value = false
  void session.start(selected.value)
}
onBeforeUnmount(() => {
  metadataAbort.abort()
  session.cancel()
})
</script>

<template>
  <NuxtLayout>
    <main id="conteudo">
      <h1>Arquivos</h1>
      <p>
        Envie um arquivo ou escolha um arquivo da impressora para iniciar a
        impressão pela conexão direta.
      </p>
      <p v-if="state.kind === 'loading'" role="status">Carregando farms…</p>
      <template v-else-if="!ready">
        <p role="alert">Não foi possível carregar suas farms.</p>
        <button type="button" @click="discover()">Tentar novamente</button>
        <NuxtLink to="/entrar">Entrar</NuxtLink>
      </template>
      <template v-else>
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
        <p v-if="!ready.farms.length">Nenhuma farm nesta página.</p>
        <button
          v-if="ready.farmAfter"
          type="button"
          :disabled="busy"
          @click="discover()"
        >
          Primeira página de farms
        </button>
        <button
          v-if="ready.nextFarm"
          type="button"
          :disabled="busy"
          @click="discover(ready.nextFarm)"
        >
          Próximas farms
        </button>
        <template v-if="ready.scope">
          <template v-if="ready.keys.kind === 'available'">
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
          </template>
          <p v-else role="status">
            É necessário um dispositivo aprovado deste navegador.
            <NuxtLink to="/dispositivos">Gerenciar dispositivos</NuxtLink>
          </p>
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
          <p v-if="row">
            Impressora selecionada: {{ row.assignment.printerKey }}
          </p>
          <p v-if="ready.inventory === 'loading'" role="status">
            Carregando impressoras…
          </p>
          <p v-else-if="!ready.rows.length">Nenhuma impressora nesta página.</p>
          <button
            v-if="ready.printerAfter"
            type="button"
            :disabled="busy"
            @click="selectFarm(ready.scope.farmId)"
          >
            Primeira página de impressoras
          </button>
          <button
            v-if="ready.nextPrinter"
            type="button"
            :disabled="busy"
            @click="selectFarm(ready.scope.farmId, ready.nextPrinter)"
          >
            Próximas impressoras
          </button>
          <p v-if="!availability.available" id="files-unavailable">
            {{ availability.reason }} O modo degradado permite somente leitura.
          </p>
          <section aria-labelledby="upload-title" :aria-busy="busy">
            <h2 id="upload-title">Enviar arquivo</h2>
            <form @submit.prevent="send">
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
              <button
                type="submit"
                :disabled="
                  busy ||
                  !availability.available ||
                  !upload ||
                  !!validateUpload(upload)
                "
              >
                Enviar arquivo
              </button>
            </form>
            <progress
              v-if="operation.kind === 'uploading'"
              :value="operation.sent"
              :max="operation.total"
              aria-label="Progresso do envio"
            />
          </section>
          <section aria-labelledby="list-title">
            <h2 id="list-title">Arquivos da impressora</h2>
            <button
              type="button"
              :disabled="busy || !availability.available"
              @click="list"
            >
              Consultar arquivos
            </button>
            <p v-if="!files.length">
              Consulte os arquivos da impressora ou envie um arquivo.
            </p>
            <form v-else @submit.prevent="start">
              <label for="files-existing">Arquivo para imprimir</label>
              <select id="files-existing" v-model="selected" :disabled="busy">
                <option value="">Selecione um arquivo</option>
                <option
                  v-for="file in files"
                  :key="file.name"
                  :value="file.name"
                  :disabled="!printableFile(file.name)"
                >
                  {{ file.name }} ({{ file.size.toLocaleString('pt-BR') }}
                  bytes)
                </option>
              </select>
              <p>Subpastas não são aceitas pelo comando de impressão atual.</p>
              <label class="confirmation"
                ><input
                  v-model="confirmed"
                  type="checkbox"
                  :disabled="busy || !selected || !availability.available"
                />Conferi o arquivo {{ selected || 'selecionado' }} e a
                impressora {{ row?.assignment.printerKey }}. Quero iniciar esta
                impressão.</label
              >
              <button
                type="submit"
                :disabled="
                  busy || !availability.available || !selected || !confirmed
                "
              >
                Iniciar impressão
              </button>
            </form>
          </section>
        </template>
      </template>
      <p role="status" aria-live="polite">{{ message }}</p>
      <button
        v-if="busy && operation.kind !== 'starting'"
        type="button"
        @click="session.cancel()"
      >
        Cancelar operação
      </button>
    </main>
  </NuxtLayout>
</template>

<style scoped>
main {
  max-width: 52rem;
  margin-inline: auto;
  padding: 1rem;
  overflow-wrap: anywhere;
}
section {
  margin-block: 1.5rem;
}
label {
  display: block;
  margin-block: 0.75rem 0.3rem;
}
button,
select,
input {
  font: inherit;
  max-width: 100%;
  min-height: 2.75rem;
}
button,
select {
  padding: 0.6rem;
}
select {
  width: 100%;
  min-width: 0;
}
button {
  margin: 0.5rem 0.5rem 0.5rem 0;
}
.confirmation {
  display: flex;
  gap: 0.75rem;
  align-items: center;
}
progress {
  width: 100%;
}
:is(button, select, input, a):focus-visible {
  outline: 3px solid currentColor;
  outline-offset: 3px;
}
</style>
