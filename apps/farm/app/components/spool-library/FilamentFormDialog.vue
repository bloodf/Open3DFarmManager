<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import Button from '../ui/Button.vue'
import Dialog from '../ui/Dialog.vue'
import Field from '../ui/Field.vue'
import {
  normalizeColorHex,
  validateFilamentForm,
  type FilamentFormState,
} from '../../utils/spool-library-format.ts'
import type {
  FilamentItem,
  VendorItem,
} from '../../utils/spool-library-types.ts'

const props = defineProps<{
  filament: FilamentItem | null
  vendors: readonly VendorItem[]
  busy?: boolean
  serverError?: string
}>()

const open = defineModel<boolean>({ required: true })
const emit = defineEmits<{ save: [payload: Record<string, unknown>] }>()

const form = reactive<FilamentFormState>({
  name: '',
  vendorId: '',
  material: '',
  density: '1.24',
  diameter: '1.75',
  weight: '',
  spoolWeight: '',
  price: '',
  articleNumber: '',
  extruderTemp: '',
  bedTemp: '',
  colorMode: 'none',
  colorHex: '176544',
  multiColorHexes: '',
  multiColorDirection: 'coaxial',
  comment: '',
})

const fieldErrors = ref<Partial<Record<keyof FilamentFormState, string>>>({})
const errorBox = ref<HTMLElement | null>(null)

const title = computed(() =>
  props.filament ? `Editar filamento #${props.filament.id}` : 'Novo filamento',
)

const pickerHex = computed(() => {
  const clean = normalizeColorHex(form.colorHex)
  return clean ? `#${clean.slice(0, 6)}` : '#176544'
})

function onColorPick(event: Event) {
  const input = event.currentTarget
  if (input instanceof HTMLInputElement && input.value) {
    form.colorHex = input.value.replace(/^#/, '').toUpperCase()
  }
}

function resetFromProps() {
  fieldErrors.value = {}
  if (props.filament) {
    form.name = props.filament.name ?? ''
    form.vendorId = props.filament.vendor
      ? String(props.filament.vendor.id)
      : ''
    form.material = props.filament.material ?? ''
    form.density = String(props.filament.density)
    form.diameter = String(props.filament.diameter)
    form.weight =
      props.filament.weight !== undefined ? String(props.filament.weight) : ''
    form.spoolWeight =
      props.filament.spool_weight !== undefined
        ? String(props.filament.spool_weight)
        : ''
    form.price =
      props.filament.price !== undefined ? String(props.filament.price) : ''
    form.articleNumber = props.filament.article_number ?? ''
    form.extruderTemp =
      props.filament.settings_extruder_temp !== undefined
        ? String(props.filament.settings_extruder_temp)
        : ''
    form.bedTemp =
      props.filament.settings_bed_temp !== undefined
        ? String(props.filament.settings_bed_temp)
        : ''
    if (props.filament.multi_color_hexes) {
      form.colorMode = 'multi'
      form.multiColorHexes = props.filament.multi_color_hexes
      form.multiColorDirection =
        props.filament.multi_color_direction ?? 'coaxial'
      form.colorHex = '176544'
    } else if (props.filament.color_hex) {
      form.colorMode = 'single'
      form.colorHex = props.filament.color_hex
      form.multiColorHexes = ''
      form.multiColorDirection = 'coaxial'
    } else {
      form.colorMode = 'none'
      form.colorHex = '176544'
      form.multiColorHexes = ''
      form.multiColorDirection = 'coaxial'
    }
    form.comment = props.filament.comment ?? ''
  } else {
    form.name = ''
    form.vendorId = ''
    form.material = 'PLA'
    form.density = '1.24'
    form.diameter = '1.75'
    form.weight = '1000'
    form.spoolWeight = ''
    form.price = ''
    form.articleNumber = ''
    form.extruderTemp = ''
    form.bedTemp = ''
    form.colorMode = 'single'
    form.colorHex = '176544'
    form.multiColorHexes = ''
    form.multiColorDirection = 'coaxial'
    form.comment = ''
  }
}

watch(
  () => [open.value, props.filament] as const,
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
  const result = validateFilamentForm(form)
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

      <div class="grid-two">
        <Field label="Nome" :error="fieldErrors.name">
          <template #default="{ control }">
            <input
              v-bind="control"
              v-model="form.name"
              type="text"
              maxlength="64"
              placeholder="Ex.: Galaxy Black"
            />
          </template>
        </Field>

        <Field label="Material" :error="fieldErrors.material">
          <template #default="{ control }">
            <input
              v-bind="control"
              v-model="form.material"
              type="text"
              maxlength="64"
              list="filament-material-suggestions"
              placeholder="PLA, PETG, ABS…"
            />
          </template>
        </Field>
      </div>

      <datalist id="filament-material-suggestions">
        <option value="PLA" />
        <option value="PETG" />
        <option value="ABS" />
        <option value="ASA" />
        <option value="TPU" />
        <option value="Nylon" />
        <option value="PC" />
        <option value="PVA" />
      </datalist>

      <Field label="Fornecedor" :error="fieldErrors.vendorId">
        <template #default="{ control }">
          <select v-bind="control" v-model="form.vendorId">
            <option value="">Sem fornecedor</option>
            <option
              v-for="vendor in vendors"
              :key="vendor.id"
              :value="String(vendor.id)"
            >
              {{ vendor.name }}
            </option>
          </select>
        </template>
      </Field>

      <div class="grid-two">
        <Field label="Densidade (g/cm³) *" :error="fieldErrors.density">
          <template #default="{ control }">
            <input
              v-bind="control"
              v-model="form.density"
              type="number"
              step="0.01"
              min="0.01"
              inputmode="decimal"
              required
            />
          </template>
        </Field>

        <Field label="Diâmetro (mm) *" :error="fieldErrors.diameter">
          <template #default="{ control }">
            <input
              v-bind="control"
              v-model="form.diameter"
              type="number"
              step="0.01"
              min="0.01"
              inputmode="decimal"
              required
            />
          </template>
        </Field>
      </div>

      <div class="grid-two">
        <Field label="Peso líquido padrão (g)" :error="fieldErrors.weight">
          <template #default="{ control }">
            <input
              v-bind="control"
              v-model="form.weight"
              type="number"
              step="1"
              min="1"
              inputmode="decimal"
            />
          </template>
        </Field>

        <Field
          label="Peso do carretel vazio (g)"
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

        <Field label="Código do artigo" :error="fieldErrors.articleNumber">
          <template #default="{ control }">
            <input
              v-bind="control"
              v-model="form.articleNumber"
              type="text"
              maxlength="64"
            />
          </template>
        </Field>
      </div>

      <div class="grid-two">
        <Field label="Temp. do bico (°C)" :error="fieldErrors.extruderTemp">
          <template #default="{ control }">
            <input
              v-bind="control"
              v-model="form.extruderTemp"
              type="number"
              step="1"
              min="0"
              inputmode="numeric"
            />
          </template>
        </Field>

        <Field label="Temp. da mesa (°C)" :error="fieldErrors.bedTemp">
          <template #default="{ control }">
            <input
              v-bind="control"
              v-model="form.bedTemp"
              type="number"
              step="1"
              min="0"
              inputmode="numeric"
            />
          </template>
        </Field>
      </div>

      <Field label="Tipo de cor">
        <template #default="{ control }">
          <select v-bind="control" v-model="form.colorMode">
            <option value="none">Sem cor</option>
            <option value="single">Cor única</option>
            <option value="multi">Multicor</option>
          </select>
        </template>
      </Field>

      <div v-if="form.colorMode === 'single'" class="color-row">
        <Field label="Cor (HEX)" :error="fieldErrors.colorHex">
          <template #default="{ control }">
            <div class="color-inputs">
              <input
                type="color"
                aria-label="Selecionar cor"
                :value="pickerHex"
                class="color-picker"
                @input="onColorPick"
              />
              <input
                v-bind="control"
                v-model="form.colorHex"
                type="text"
                maxlength="9"
                placeholder="FF5500"
              />
            </div>
          </template>
        </Field>
      </div>

      <div v-if="form.colorMode === 'multi'" class="grid-two">
        <Field
          label="Cores (HEX separadas por vírgula)"
          hint="Mínimo 2 cores, ex.: FF0000, 0055FF."
          :error="fieldErrors.multiColorHexes"
        >
          <template #default="{ control }">
            <input
              v-bind="control"
              v-model="form.multiColorHexes"
              type="text"
              placeholder="FF0000, 0055FF"
            />
          </template>
        </Field>

        <Field label="Direção multicor">
          <template #default="{ control }">
            <select v-bind="control" v-model="form.multiColorDirection">
              <option value="coaxial">Coaxial</option>
              <option value="longitudinal">Longitudinal</option>
            </select>
          </template>
        </Field>
      </div>

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
          {{ busy ? 'Salvando…' : 'Salvar filamento' }}
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
.entity-form input:not([type='color']),
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
.color-inputs {
  display: flex;
  gap: var(--space-2);
  align-items: center;
}
.color-picker {
  flex: none;
  inline-size: 3rem;
  block-size: 2.75rem;
  padding: var(--space-1);
  border: 1px solid var(--color-text-muted);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  cursor: pointer;
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
