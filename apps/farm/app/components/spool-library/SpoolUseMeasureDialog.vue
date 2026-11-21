<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import Button from '../ui/Button.vue'
import Dialog from '../ui/Dialog.vue'
import Field from '../ui/Field.vue'
import {
  estimateAfterMeasure,
  estimateAfterUse,
  formatSpoolWeight,
  spoolDisplayTitle,
  spoolTareWeight,
} from '../../utils/spool-library-format.ts'
import type { SpoolItem } from '../../utils/spool-library-types.ts'

const props = defineProps<{
  spool: SpoolItem | null
  mode: 'use' | 'measure'
  busy?: boolean
  serverError?: string
}>()

const open = defineModel<boolean>({ required: true })
const emit = defineEmits<{
  submitUse: [payload: { use_weight?: number; use_length?: number }]
  submitMeasure: [payload: { weight: number }]
}>()

const useUnit = ref<'weight' | 'length'>('weight')
const amount = ref('')
const localError = ref('')
const errorBox = ref<HTMLElement | null>(null)

const title = computed(() => {
  if (!props.spool)
    return props.mode === 'use' ? 'Registrar uso' : 'Pesar bobina'
  return props.mode === 'use'
    ? `Registrar uso · Bobina #${props.spool.id}`
    : `Registrar pesagem · Bobina #${props.spool.id}`
})

const parsedNumber = computed(() => {
  const cleaned = String(amount.value ?? '')
    .trim()
    .replace(',', '.')
  if (!cleaned) return null
  const value = Number(cleaned)
  return Number.isFinite(value) ? value : Number.NaN
})

const usePreview = computed(() => {
  if (props.mode !== 'use' || !props.spool || parsedNumber.value === null)
    return null
  return estimateAfterUse(props.spool, useUnit.value, parsedNumber.value)
})

const measurePreview = computed(() => {
  if (props.mode !== 'measure' || !props.spool || parsedNumber.value === null)
    return null
  return estimateAfterMeasure(props.spool, parsedNumber.value)
})

const tareLabel = computed(() =>
  props.spool ? formatSpoolWeight(spoolTareWeight(props.spool) ?? 0) : '—',
)

watch(
  () => [open.value, props.spool?.id, props.mode] as const,
  ([isOpen]) => {
    if (!isOpen) return
    useUnit.value = 'weight'
    amount.value = ''
    localError.value = ''
  },
)

watch(
  () => props.serverError,
  async (value) => {
    if (!value) return
    await nextTick()
    errorBox.value?.focus()
  },
)

async function submit() {
  if (props.busy || !props.spool) return
  localError.value = ''
  const value = parsedNumber.value
  if (value === null || !Number.isFinite(value)) {
    localError.value =
      props.mode === 'use'
        ? 'Informe a quantidade consumida.'
        : 'Informe o peso bruto medido na balança.'
    await nextTick()
    errorBox.value?.focus()
    return
  }
  if (props.mode === 'use') {
    if (value === 0) {
      localError.value = 'Informe um valor diferente de zero.'
      await nextTick()
      errorBox.value?.focus()
      return
    }
    emit(
      'submitUse',
      useUnit.value === 'weight'
        ? { use_weight: value }
        : { use_length: value },
    )
    return
  }

  if (value < 0) {
    localError.value = 'Informe um peso maior ou igual a zero.'
    await nextTick()
    errorBox.value?.focus()
    return
  }
  const preview = estimateAfterMeasure(props.spool, value)
  if ('error' in preview) {
    localError.value = preview.error
    await nextTick()
    errorBox.value?.focus()
    return
  }
  emit('submitMeasure', { weight: value })
}
</script>

<template>
  <Dialog v-model="open" :title="title">
    <form v-if="spool" class="entity-form" novalidate @submit.prevent="submit">
      <p class="summary">
        <strong>{{ spoolDisplayTitle(spool) }}</strong>
        · Restante atual: {{ formatSpoolWeight(spool.remaining_weight) }}
      </p>

      <div
        v-if="serverError || localError"
        ref="errorBox"
        role="alert"
        tabindex="-1"
        class="dialog-error"
      >
        {{ serverError || localError }}
      </div>

      <template v-if="mode === 'use'">
        <Field label="Unidade de consumo">
          <template #default="{ control }">
            <select v-bind="control" v-model="useUnit">
              <option value="weight">Peso em gramas (g)</option>
              <option value="length">Comprimento em milímetros (mm)</option>
            </select>
          </template>
        </Field>

        <Field
          :label="
            useUnit === 'weight'
              ? 'Peso consumido (g)'
              : 'Comprimento consumido (mm)'
          "
          hint="Use valores positivos para consumo ou negativos para estorno."
        >
          <template #default="{ control }">
            <input
              v-bind="control"
              v-model="amount"
              type="number"
              step="0.1"
              inputmode="decimal"
              required
            />
          </template>
        </Field>

        <p v-if="usePreview" role="status" class="preview">
          Consumo estimado: {{ formatSpoolWeight(usePreview.deltaGrams) }}
          <template v-if="usePreview.nextRemaining !== null">
            · Novo restante: {{ formatSpoolWeight(usePreview.nextRemaining) }}
          </template>
        </p>
      </template>

      <template v-else>
        <Field
          label="Peso bruto na balança (g)"
          :hint="`Tara do carretel considerada: ${tareLabel}.`"
        >
          <template #default="{ control }">
            <input
              v-bind="control"
              v-model="amount"
              type="number"
              step="0.1"
              min="0"
              inputmode="decimal"
              required
            />
          </template>
        </Field>

        <p
          v-if="measurePreview && !('error' in measurePreview)"
          role="status"
          class="preview"
        >
          Novo peso líquido restante estimado:
          <strong>{{ formatSpoolWeight(measurePreview.nextRemaining) }}</strong>
        </p>
      </template>

      <div class="dialog-actions">
        <Button :disabled="busy" @click="open = false">Cancelar</Button>
        <Button type="submit" class="primary" :disabled="busy">
          {{
            busy
              ? 'Registrando…'
              : mode === 'use'
                ? 'Confirmar uso'
                : 'Confirmar pesagem'
          }}
        </Button>
      </div>
    </form>
  </Dialog>
</template>

<style scoped>
.entity-form {
  display: grid;
  gap: var(--space-3);
}
.summary {
  margin: 0;
  color: var(--color-text-muted);
  overflow-wrap: anywhere;
}
.entity-form input,
.entity-form select {
  width: 100%;
  min-height: 2.75rem;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-text-muted);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text);
  font: inherit;
}
.entity-form input:focus-visible,
.entity-form select:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.preview {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-inline-start: var(--space-1) solid var(--color-accent);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-sm);
}
.dialog-error {
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-inline-start: var(--space-1) solid var(--printer-error);
  border-radius: var(--radius-sm);
}
.dialog-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
}
.primary {
  background: var(--color-accent);
  color: var(--color-on-accent);
  font-weight: var(--font-weight-semibold);
}
</style>
