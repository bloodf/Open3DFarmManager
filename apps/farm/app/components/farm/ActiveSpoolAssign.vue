<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

const props = defineProps<{
  farmId: string
  printerKey: string
  slots: readonly string[]
  busy?: boolean
  moonrakerManaged?: boolean
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
    const raw = localStorage.getItem(storageKey())
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
  localStorage.setItem(storageKey(), JSON.stringify(value))
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
  () => syncDraft(),
)

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
        <label :for="`spool-slot-${printerKey}-${slot}`">
          {{ slot }}
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
