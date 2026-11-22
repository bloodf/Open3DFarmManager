<script setup lang="ts">
import type { ReplaySend } from '../../utils/replay-live.ts'
import { computed, ref, watch } from 'vue'
import Dialog from '../ui/Dialog.vue'
import Button from '../ui/Button.vue'
import { locationLabel, safeColour } from '../../utils/library-view.ts'
import { replayOutcomeLocks } from '../../utils/replay-outcome.ts'
import {
  GROUP_LABELS,
  buildArgs,
  confirmationError,
  defaultPrinter,
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
/** Colour of the slot chosen for a filament, painted only when it is a safe hex. */
function paint(index: number) {
  const hex = selected.value?.materials.find(
    (m, slot) => slotValue(m, slot) === mapping.value[index],
  )?.colorHex
  return safeColour(
    hex && /^[0-9A-F]{8}$/i.test(hex) ? `#${hex.slice(0, 6)}` : '',
  )
}

async function confirm() {
  const printer = selected.value
  if (!printer || problem.value || sending.value || result.value) return
  sending.value = true
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
              {{ m.colorHex ? `· #${m.colorHex.slice(0, 6)}` : '' }}
            </option>
          </select>
          <span
            v-if="paint(index)"
            class="swatch"
            aria-hidden="true"
            :style="{ background: paint(index) }"
          ></span>
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
.swatch {
  display: inline-block;
  inline-size: 1rem;
  block-size: 1rem;
  border: 1px solid var(--text-muted);
}
</style>
