<script setup lang="ts">
import type { ReplaySend } from '../../utils/replay-live.ts'
import { computed, ref, watch } from 'vue'
import Dialog from '../ui/Dialog.vue'
import Button from '../ui/Button.vue'
import { locationLabel } from '../../utils/library-view.ts'
import type { MatchedSlot } from '../../utils/filament-match.ts'
import FilamentMatch from './FilamentMatch.vue'
import { replayOutcomeLocks } from '../../utils/replay-outcome.ts'
import {
  GROUP_LABELS,
  buildArgs,
  confirmationError,
  defaultPrinter,
  effectiveSlotColour,
  groupPrinters,
  replayOutcomeText,
  suggestMapping,
  usesAms,
  type ReplayLevel,
  type ReplayPrinter,
  type ReplayResult,
  type ReplaySource,
} from '../../utils/replay-view.ts'

const props = defineProps<{
  itemId?: string
  source: ReplaySource
  printers: readonly ReplayPrinter[]
  /** Printer of the original job; preselected when it can still be used. */
  preferredPrinter?: string
  preferredPlate?: number
  /** Sends the signed `start_library_print` over the live session. Never retried here. */
  send: ReplaySend
}>()
const open = defineModel<boolean>({ required: true })

const levels: ReplayLevel[] = ['ok', 'warn', 'blocked']
const groups = computed(() => groupPrinters(props.source, props.printers))
const selectedKey = ref('')
const plate = ref(1)
const mapping = ref<number[]>([])
const bedClear = ref(false)
const sending = ref(false)
/** A settled attempt locks the form: an uncertain command is never resent. */
const result = ref<ReplayResult | null>(null)
const reconnecting = ref(false)
const connectionNotice = ref('')

const selected = computed(() =>
  props.printers.find((printer) => printer.key === selectedKey.value),
)
const tools = computed(() => props.source.metadata.tools ?? [])
const ams = computed(
  () => !!selected.value && usesAms(props.source, selected.value),
)
const bambu = computed(() => selected.value?.backend === 'bambu')
const where = computed(() => locationLabel(props.source.storageLocation))
const problem = computed(() =>
  selected.value
    ? confirmationError({
        printer: selected.value,
        source: props.source,
        plate: plate.value,
        mapping: mapping.value,
        bedClear: bedClear.value,
      })
    : 'Escolha uma impressora.',
)
const outcome = computed(() =>
  result.value ? replayOutcomeText(result.value) : '',
)
const reasons = computed(() => result.value?.reasons ?? [])
const outcomeLockKey = () => props.itemId ?? props.source.sha256

function reset() {
  result.value = replayOutcomeLocks.get(outcomeLockKey())
  connectionNotice.value = ''
  bedClear.value = false
  selectedKey.value = defaultPrinter(groups.value, props.preferredPrinter)
  plate.value = Math.min(
    Math.max(props.preferredPlate ?? 1, 1),
    props.source.plateCount,
  )
}
watch(
  [() => open.value, () => outcomeLockKey(), () => props.source.sha256],
  ([isOpen]) => {
    if (isOpen) reset()
  },
  { immediate: true },
)
watch(
  [() => selectedKey.value, () => props.source.sha256],
  () => {
    bedClear.value = false
    mapping.value = selected.value
      ? suggestMapping(props.source, selected.value)
      : []
  },
  { immediate: true },
)

const slotLabel = (m: ReplayPrinter['materials'][number], index: number) =>
  `Slot ${m.slot || index + 1}: ${m.materialType ?? 'material desconhecido'}`
const slotValue = (m: ReplayPrinter['materials'][number], index: number) =>
  /^\d{1,3}$/.test(m.slot) ? Number(m.slot) : index
/** The slot chosen for a filament, as the match view shows it; null until one is chosen.
 * Spoolman's colour and percentage for the slot's active spool come first. */
function chosen(index: number): MatchedSlot | null {
  const printer = selected.value
  if (!printer) return null
  const at = printer.materials.findIndex(
    (m, slot) => slotValue(m, slot) === mapping.value[index],
  )
  const m = printer.materials[at]
  if (!m) return null
  return {
    label: `Slot ${m.slot || at + 1}`,
    materialType: m.materialType,
    // Spoolman's active spool first, as the local reel did; else the printer.
    colorHex: effectiveSlotColour(m),
    remainingPercent: m.remainingPercent,
    spoolmanRemainingPercent: m.spoolmanRemainingPercent,
  }
}

async function confirm() {
  const printer = selected.value
  if (!printer || problem.value || sending.value || result.value) return
  sending.value = true
  connectionNotice.value = ''
  const { sha256, versionId } = props.source
  const itemId = props.itemId
  const lockKey = outcomeLockKey()
  const chosenPlate = plate.value
  const chosenMapping = mapping.value.join(',')
  let settled: ReplayResult
  try {
    settled = await props.send(
      printer.key,
      buildArgs({
        printer,
        source: props.source,
        plate: plate.value,
        mapping: mapping.value,
        bedClear: bedClear.value,
      }),
      () =>
        open.value &&
        props.itemId === itemId &&
        props.source.sha256 === sha256 &&
        props.source.versionId === versionId &&
        selectedKey.value === printer.key &&
        plate.value === chosenPlate &&
        mapping.value.join(',') === chosenMapping &&
        !problem.value,
      versionId,
    )
  } catch {
    settled = { outcome: 'outcome-unknown' }
  } finally {
    sending.value = false
  }
  replayOutcomeLocks.record(lockKey, settled)
  if (outcomeLockKey() === lockKey) result.value = settled
}

/** After a failed handshake only the connection is tried again, never the print. */
async function retryConnection() {
  const printer = selected.value
  const failed = result.value
  if (!printer || !failed || !props.send.reconnect || reconnecting.value) return
  reconnecting.value = true
  connectionNotice.value = ''
  const connected = await props.send.reconnect(printer.key).catch(() => false)
  reconnecting.value = false
  // The dialog was closed or reused while the connection was being tried.
  if (!open.value || result.value !== failed) return
  if (!connected) {
    connectionNotice.value = 'A conexão com o Connector continua falhando.'
    return
  }
  result.value = null
  bedClear.value = false
  connectionNotice.value =
    'Conexão restabelecida. Nada foi enviado: confira a mesa e confirme novamente.'
}

function confirmPrinterChecked() {
  replayOutcomeLocks.confirmPrinterChecked(outcomeLockKey())
  result.value = null
}
</script>

<template>
  <Dialog v-model="open" title="Imprimir de novo">
    <p>
      Arquivo: <strong>{{ source.name }}</strong>
    </p>
    <p data-testid="storage-note">
      Guardado em: {{ where }}.
      <template v-if="source.storageLocation === 'connector'">
        O arquivo fica guardado no Connector e o servidor não tem cópia. O
        Connector usa a cópia dele e confere o SHA-256 antes de imprimir.
      </template>
      <template v-else>
        O Connector usa o cache dele ou baixa o arquivo do servidor, e confere o
        SHA-256 antes de imprimir.
      </template>
    </p>
    <p v-if="source.purged" role="alert">
      O arquivo desta versão foi removido da biblioteca. Envie o arquivo
      novamente.
    </p>

    <fieldset :disabled="sending || result !== null">
      <legend>Impressora</legend>
      <p v-if="!printers.length">Nenhuma impressora disponível nesta farm.</p>
      <template v-for="level in levels" :key="level">
        <section
          v-if="groups[level].length"
          :data-group="level"
          :aria-label="GROUP_LABELS[level]"
        >
          <h3>{{ GROUP_LABELS[level] }}</h3>
          <div v-for="entry in groups[level]" :key="entry.printer.key">
            <input
              :id="`replay-printer-${entry.printer.key}`"
              v-model="selectedKey"
              type="radio"
              name="replay-printer"
              :value="entry.printer.key"
              :disabled="!!entry.disabledReason || level === 'blocked'"
              :aria-describedby="`replay-why-${entry.printer.key}`"
            />
            <label :for="`replay-printer-${entry.printer.key}`">{{
              entry.printer.label
            }}</label>
            <ul :id="`replay-why-${entry.printer.key}`">
              <li v-if="entry.disabledReason">{{ entry.disabledReason }}</li>
              <li v-for="reason in entry.reasons" :key="reason">
                {{ reason }}
              </li>
            </ul>
          </div>
        </section>
      </template>

      <div v-if="bambu && source.plateCount > 0">
        <label for="replay-plate">Placa</label>
        <select id="replay-plate" v-model.number="plate">
          <option v-for="n in source.plateCount" :key="n" :value="n">
            Placa {{ n }} de {{ source.plateCount }}
          </option>
        </select>
      </div>

      <section v-if="ams && selected" aria-label="Mapeamento do AMS">
        <h3>Filamentos e slots do AMS</h3>
        <div v-for="(tool, index) in tools" :key="index">
          <label :for="`replay-slot-${index}`">
            Filamento {{ index + 1 }}:
            {{ tool.filamentType ?? 'material não informado' }}
            <template v-if="tool.filamentColour">
              ({{ tool.filamentColour }})
            </template>
          </label>
          <select :id="`replay-slot-${index}`" v-model.number="mapping[index]">
            <option :value="-1">Escolha um slot</option>
            <option
              v-for="(m, slot) in selected.materials"
              :key="m.slot"
              :value="slotValue(m, slot)"
            >
              {{ slotLabel(m, slot) }}
              {{
                effectiveSlotColour(m)
                  ? `· #${effectiveSlotColour(m)!.slice(0, 6)}`
                  : ''
              }}
            </option>
          </select>
          <FilamentMatch
            :index="index + 1"
            :required="{
              type: tool.filamentType,
              colour: tool.filamentColour,
            }"
            :matched="chosen(index)"
          />
        </div>
      </section>

      <div>
        <input id="replay-bed" v-model="bedClear" type="checkbox" />
        <label for="replay-bed"
          >Confirmo que a mesa está limpa e livre de objetos.</label
        >
      </div>
    </fieldset>

    <p v-if="problem && !result" role="note">{{ problem }}</p>
    <p v-if="sending" role="status">
      Conectando ao Connector e enviando o comando…
    </p>
    <div
      v-if="result"
      :role="result.outcome === 'applied' ? 'status' : 'alert'"
    >
      <p>{{ outcome }}</p>
      <ul v-if="reasons.length">
        <li v-for="reason in reasons" :key="reason">{{ reason }}</li>
      </ul>
    </div>
    <div v-if="result?.code === 'session-handshake-failed' && send.reconnect">
      <Button :disabled="reconnecting" @click="retryConnection"
        >Tentar conectar novamente</Button
      >
    </div>
    <p v-if="reconnecting" role="status">Conectando ao Connector…</p>
    <p v-else-if="connectionNotice" role="status">{{ connectionNotice }}</p>
    <div v-if="result?.outcome === 'outcome-unknown'">
      <p>
        Verifique a impressora. Se a impressão não começou, confirme abaixo para
        liberar uma nova tentativa.
      </p>
      <Button @click="confirmPrinterChecked"
        >Confirmei que a impressão não começou</Button
      >
    </div>
    <Button :disabled="!!problem || sending || result !== null" @click="confirm"
      >Imprimir de novo</Button
    >
  </Dialog>
</template>

<style scoped>
fieldset {
  border: 0;
  padding: 0;
}
ul {
  margin-block: 0 var(--space-2);
  color: var(--text-muted);
}
</style>
