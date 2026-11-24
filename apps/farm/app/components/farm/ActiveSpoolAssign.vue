<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { PrinterState } from '../../../../../packages/farm-protocol/src/state.ts'
import { farmSlotLabel, farmSlotViews } from '../../utils/farm-slot-view.ts'
import FarmSpool from '../spool-art/FarmSpool.vue'
import {
  safeReadStored,
  safeWriteStored,
  sameSlots,
} from '../../utils/spool-form-state.ts'

const props = defineProps<{
  farmId: string
  printerKey: string
  slots: readonly string[]
  busy?: boolean
  moonrakerManaged?: boolean
  /** Live materials of the printer, to draw each slot's spool. Never last-known ones. */
  materials?: PrinterState['materials']
}>()

const emit = defineEmits<{
  change: [payload: Readonly<Record<string, number>>]
}>()

const draft = ref<Record<string, string>>({})
const assignments = ref<Record<string, number>>({})

function storageKey() {
  return `openfarm.active-spool.${props.farmId}.${props.printerKey}`
}

function readStored(): Record<string, number> {
  try {
    const raw = safeReadStored(
      typeof localStorage === 'undefined' ? null : localStorage,
      storageKey(),
    )
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
      return {}
    const next: Record<string, number> = {}
    for (const [slot, value] of Object.entries(parsed)) {
      if (
        typeof slot === 'string' &&
        slot.length > 0 &&
        slot.length <= 32 &&
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value > 0
      )
        next[slot] = value
    }
    return next
  } catch {
    return {}
  }
}

function writeStored(value: Record<string, number>) {
  try {
    safeWriteStored(
      typeof localStorage === 'undefined' ? null : localStorage,
      storageKey(),
      JSON.stringify(value),
    )
  } catch {
    // Storage may be unavailable in this browser context.
  }
}

function syncDraft() {
  const next: Record<string, string> = {}
  for (const slot of props.slots) {
    const id = assignments.value[slot]
    next[slot] = id === undefined ? '' : String(id)
  }
  draft.value = next
}

onMounted(() => {
  assignments.value = readStored()
  syncDraft()
  emit('change', { ...assignments.value })
})

watch(
  () => props.slots,
  (slots, previous) => {
    if (!previous || !sameSlots(slots, previous)) syncDraft()
  },
)

watch(
  () => [props.farmId, props.printerKey] as const,
  () => {
    assignments.value = readStored()
    syncDraft()
    emit('change', { ...assignments.value })
  },
)

const spools = computed(
  () => new Map((farmSlotViews(props.materials) ?? []).map((v) => [v.key, v])),
)

function fractionOf(slot: string): number | null {
  const level = spools.value.get(slot)?.level
  return level?.kind === 'known' ? level.fraction : null
}

const disabled = computed(
  () => props.busy === true || props.moonrakerManaged === true,
)

function save(slot: string) {
  if (disabled.value) return
  const raw = draft.value[slot]?.trim() ?? ''
  const next = { ...assignments.value }
  if (!raw) delete next[slot]
  else if (/^\d{1,15}$/.test(raw)) next[slot] = Number(raw)
  else return
  assignments.value = next
  writeStored(next)
  syncDraft()
  emit('change', { ...next })
}
</script>

<template>
  <section
    class="active-spool-assign"
    :aria-labelledby="`active-spool-${printerKey}`"
  >
    <h4 :id="`active-spool-${printerKey}`">Bobina ativa por ferramenta</h4>
    <p v-if="moonrakerManaged" role="status">
      A bobina ativa vem do Spoolman no Moonraker desta impressora. A atribuição
      manual fica desligada enquanto essa fonte estiver disponível.
    </p>
    <p v-else>
      Informe o id da bobina no Spoolman para cada ferramenta ou bandeja AMS. A
      escolha permanece após reiniciar.
    </p>
    <ul>
      <li v-for="slot in slots" :key="slot">
        <FarmSpool
          v-if="spools.get(slot)"
          :color="spools.get(slot)?.color"
          :fraction="fractionOf(slot)"
          :size="32"
        />
        <label :for="`spool-slot-${printerKey}-${slot}`">
          {{ farmSlotLabel(slot) }}
          <template v-if="spools.get(slot)">
            · {{ spools.get(slot)?.material }}
            <template v-if="!spools.get(slot)?.color">
              · Cor não informada
            </template>
          </template>
        </label>
        <input
          :id="`spool-slot-${printerKey}-${slot}`"
          v-model="draft[slot]"
          type="text"
          inputmode="numeric"
          pattern="[0-9]*"
          maxlength="15"
          autocomplete="off"
          :disabled="disabled"
          :aria-describedby="`spool-slot-help-${printerKey}`"
        />
        <button type="button" :disabled="disabled" @click="save(slot)">
          Salvar
        </button>
      </li>
    </ul>
    <p :id="`spool-slot-help-${printerKey}`">
      Use o identificador numérico da bobina no Spoolman. Deixe em branco para
      remover a associação.
    </p>
  </section>
</template>

<style scoped>
.active-spool-assign {
  margin: 1rem 0;
}
ul {
  list-style: none;
  padding: 0;
  margin: 0.5rem 0 0;
}
li {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
  margin-bottom: 0.5rem;
}
label {
  font-weight: 600;
  min-width: 6rem;
}
input {
  max-width: 10rem;
}
</style>
