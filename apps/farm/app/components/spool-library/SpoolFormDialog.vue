<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import Button from '../ui/Button.vue'
import Dialog from '../ui/Dialog.vue'
import Field from '../ui/Field.vue'
import SpoolIllustration from './SpoolIllustration.vue'
import {
  filamentDisplayTitle,
  validateSpoolForm,
  type SpoolFormState,
} from '../../utils/spool-library-format.ts'
import type {
  FilamentItem,
  SpoolItem,
} from '../../utils/spool-library-types.ts'

const props = defineProps<{
  spool: SpoolItem | null
  filaments: readonly FilamentItem[]
  busy?: boolean
  serverError?: string
}>()

const open = defineModel<boolean>({ required: true })
const emit = defineEmits<{ save: [payload: Record<string, unknown>] }>()

const form = reactive<SpoolFormState>({
  filamentId: '',
  initialWeight: '',
  spoolWeight: '',
  weightMode: 'remaining',
  remainingWeight: '',
  usedWeight: '',
  price: '',
  location: '',
  lotNr: '',
  comment: '',
  archived: false,
})

const fieldErrors = ref<Partial<Record<keyof SpoolFormState, string>>>({})
const errorBox = ref<HTMLElement | null>(null)

const title = computed(() =>
  props.spool ? `Editar bobina #${props.spool.id}` : 'Nova bobina',
)

function resetFromProps() {
  fieldErrors.value = {}
  if (props.spool) {
    form.filamentId = String(props.spool.filament.id)
    form.initialWeight =
      props.spool.initial_weight !== undefined
        ? String(props.spool.initial_weight)
        : ''
    form.spoolWeight =
      props.spool.spool_weight !== undefined
        ? String(props.spool.spool_weight)
        : ''
    form.weightMode =
      props.spool.remaining_weight !== undefined ? 'remaining' : 'used'
    form.remainingWeight =
      props.spool.remaining_weight !== undefined
        ? String(Math.round(props.spool.remaining_weight * 10) / 10)
        : ''
    form.usedWeight = String(Math.round(props.spool.used_weight * 10) / 10)
    form.price =
      props.spool.price !== undefined ? String(props.spool.price) : ''
    form.location = props.spool.location ?? ''
    form.lotNr = props.spool.lot_nr ?? ''
    form.comment = props.spool.comment ?? ''
    form.archived = props.spool.archived
  } else {
    form.filamentId = props.filaments[0] ? String(props.filaments[0].id) : ''
    form.initialWeight = ''
    form.spoolWeight = ''
    form.weightMode = 'remaining'
    form.remainingWeight = ''
    form.usedWeight = ''
    form.price = ''
    form.location = ''
    form.lotNr = ''
    form.comment = ''
    form.archived = false
  }
}

watch(
  () => [open.value, props.spool] as const,
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
  const result = validateSpoolForm(form)
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
      <SpoolIllustration v-if="spool" :spool="spool" />
      <div
        v-if="serverError || Object.keys(fieldErrors).length"
        ref="errorBox"
        role="alert"
        tabindex="-1"
        class="dialog-error"
      >
        {{ serverError || 'Revise os campos destacados antes de salvar.' }}
      </div>

      <Field
        label="Filamento *"
        hint="Escolha o filamento cadastrado para esta bobina."
        :error="fieldErrors.filamentId"
      >
        <template #default="{ control }">
          <select v-bind="control" v-model="form.filamentId" required>
            <option disabled value="">Selecione um filamento</option>
            <option
              v-for="filament in filaments"
              :key="filament.id"
              :value="String(filament.id)"
            >
              {{ filamentDisplayTitle(filament) }}
              {{ filament.material ? `(${filament.material})` : '' }}
            </option>
          </select>
        </template>
      </Field>

      <div class="grid-two">
        <Field
          label="Peso inicial (g)"
          hint="Deixe em branco para herdar do filamento."
          :error="fieldErrors.initialWeight"
        >
          <template #default="{ control }">
            <input
              v-bind="control"
              v-model="form.initialWeight"
              type="number"
              step="0.1"
              min="0"
              inputmode="decimal"
            />
          </template>
        </Field>

        <Field
          label="Peso do carretel vazio (g)"
          hint="Opcional; herda do filamento."
          :error="fieldErrors.spoolWeight"
        >
          <template #default="{ control }">
            <input
              v-bind="control"
              v-model="form.spoolWeight"
              type="number"
              step="0.1"
              min="0"
              inputmode="decimal"
            />
          </template>
        </Field>
      </div>

      <div class="grid-two">
        <Field label="Informar estoque por">
          <template #default="{ control }">
            <select v-bind="control" v-model="form.weightMode">
              <option value="remaining">Peso restante (g)</option>
              <option value="used">Peso já usado (g)</option>
            </select>
          </template>
        </Field>

        <Field
          v-if="form.weightMode === 'remaining'"
          label="Peso restante (g)"
          :error="fieldErrors.remainingWeight"
        >
          <template #default="{ control }">
            <input
              v-bind="control"
              v-model="form.remainingWeight"
              type="number"
              step="0.1"
              min="0"
              inputmode="decimal"
            />
          </template>
        </Field>

        <Field v-else label="Peso usado (g)" :error="fieldErrors.usedWeight">
          <template #default="{ control }">
            <input
              v-bind="control"
              v-model="form.usedWeight"
              type="number"
              step="0.1"
              min="0"
              inputmode="decimal"
            />
          </template>
        </Field>
      </div>

      <div class="grid-two">
        <Field label="Localização" :error="fieldErrors.location">
          <template #default="{ control }">
            <input
              v-bind="control"
              v-model="form.location"
              type="text"
              maxlength="64"
              placeholder="Ex.: Estante A, Drybox 2"
            />
          </template>
        </Field>

        <Field label="Lote" :error="fieldErrors.lotNr">
          <template #default="{ control }">
            <input
              v-bind="control"
              v-model="form.lotNr"
              type="text"
              maxlength="64"
            />
          </template>
        </Field>
      </div>

      <Field label="Preço" :error="fieldErrors.price">
        <template #default="{ control }">
          <input
            v-bind="control"
            v-model="form.price"
            type="number"
            step="0.01"
            min="0"
            inputmode="decimal"
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

      <label v-if="spool" class="checkbox-field">
        <input v-model="form.archived" type="checkbox" />
        <span>Bobina arquivada</span>
      </label>

      <div class="dialog-actions">
        <Button :disabled="busy" @click="open = false">Cancelar</Button>
        <Button type="submit" class="primary" :disabled="busy">
          {{ busy ? 'Salvando…' : 'Salvar bobina' }}
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
.grid-two {
  display: grid;
  gap: var(--space-3);
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 11rem), 1fr));
}
.entity-form input:not([type='checkbox']),
.entity-form select,
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
.checkbox-field {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 2.75rem;
  font-weight: var(--font-weight-semibold);
}
.checkbox-field input {
  inline-size: 1.25rem;
  block-size: 1.25rem;
}
.entity-form input:focus-visible,
.entity-form select:focus-visible,
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
