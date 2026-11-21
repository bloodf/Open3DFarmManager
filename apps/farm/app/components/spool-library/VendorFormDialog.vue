<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import Button from '../ui/Button.vue'
import Dialog from '../ui/Dialog.vue'
import Field from '../ui/Field.vue'
import {
  validateVendorForm,
  type VendorFormState,
} from '../../utils/spool-library-format.ts'
import type { VendorItem } from '../../utils/spool-library-types.ts'

const props = defineProps<{
  vendor: VendorItem | null
  busy?: boolean
  serverError?: string
}>()

const open = defineModel<boolean>({ required: true })
const emit = defineEmits<{ save: [payload: Record<string, unknown>] }>()

const form = reactive<VendorFormState>({
  name: '',
  emptySpoolWeight: '',
  externalId: '',
  comment: '',
})

const fieldErrors = ref<Partial<Record<keyof VendorFormState, string>>>({})
const errorBox = ref<HTMLElement | null>(null)

const title = computed(() =>
  props.vendor ? `Editar fornecedor #${props.vendor.id}` : 'Novo fornecedor',
)

function resetFromProps() {
  fieldErrors.value = {}
  if (props.vendor) {
    form.name = props.vendor.name
    form.emptySpoolWeight =
      props.vendor.empty_spool_weight !== undefined
        ? String(props.vendor.empty_spool_weight)
        : ''
    form.externalId = props.vendor.external_id ?? ''
    form.comment = props.vendor.comment ?? ''
  } else {
    form.name = ''
    form.emptySpoolWeight = ''
    form.externalId = ''
    form.comment = ''
  }
}

watch(
  () => [open.value, props.vendor] as const,
  ([isOpen]) => {
    if (isOpen) resetFromProps()
  },
  { immediate: true },
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
  if (props.busy) return
  const result = validateVendorForm(form)
  if (!result.ok) {
    fieldErrors.value = result.errors
    await nextTick()
    errorBox.value?.focus()
    return
  }
  fieldErrors.value = {}
  emit('save', result.payload)
}
</script>

<template>
  <Dialog v-model="open" :title="title">
    <form class="entity-form" novalidate @submit.prevent="submit">
      <div
        v-if="serverError || Object.keys(fieldErrors).length"
        ref="errorBox"
        role="alert"
        tabindex="-1"
        class="dialog-error"
      >
        {{ serverError || 'Revise os campos destacados antes de salvar.' }}
      </div>

      <Field label="Nome *" :error="fieldErrors.name">
        <template #default="{ control }">
          <input
            v-bind="control"
            v-model="form.name"
            type="text"
            maxlength="64"
            required
          />
        </template>
      </Field>

      <Field
        label="Peso do carretel vazio (g)"
        hint="Usado como padrão para filamentos deste fornecedor."
        :error="fieldErrors.emptySpoolWeight"
      >
        <template #default="{ control }">
          <input
            v-bind="control"
            v-model="form.emptySpoolWeight"
            type="number"
            step="0.1"
            min="0"
            inputmode="decimal"
          />
        </template>
      </Field>

      <Field
        label="ID externo"
        hint="Opcional, para referência com catálogos externos."
        :error="fieldErrors.externalId"
      >
        <template #default="{ control }">
          <input
            v-bind="control"
            v-model="form.externalId"
            type="text"
            maxlength="256"
          />
        </template>
      </Field>

      <Field label="Observações" :error="fieldErrors.comment">
        <template #default="{ control }">
          <textarea
            v-bind="control"
            v-model="form.comment"
            rows="3"
            maxlength="1024"
          />
        </template>
      </Field>

      <div class="dialog-actions">
        <Button :disabled="busy" @click="open = false">Cancelar</Button>
        <Button type="submit" class="primary" :disabled="busy">
          {{ busy ? 'Salvando…' : 'Salvar fornecedor' }}
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
.entity-form input,
.entity-form textarea {
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
.entity-form textarea:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
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
