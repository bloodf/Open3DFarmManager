<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import {
  confirmButtonLabel,
  confirmCheckboxLabel,
  confirmDescription,
  confirmTitle,
  type ConfirmTarget,
} from '../../utils/members-page.ts'

const props = defineProps<{
  target: ConfirmTarget | null
  confirmed: boolean
  pending: boolean
  status: string
}>()

const emit = defineEmits<{
  'update:confirmed': [value: boolean]
  confirm: []
  cancel: []
}>()

const dialog = ref<HTMLDialogElement | null>(null)
const checkboxId = 'members-confirm-check'

watch(
  () => props.target,
  async (target) => {
    await nextTick()
    const el = dialog.value
    if (!el) return
    if (target) {
      if (!el.open) el.showModal()
    } else if (el.open) {
      el.close()
    }
  },
  { immediate: true },
)

function onCancel(event: Event) {
  event.preventDefault()
  if (!props.pending) emit('cancel')
}
</script>

<template>
  <dialog
    ref="dialog"
    aria-labelledby="members-confirm-title"
    aria-describedby="members-confirm-description"
    @cancel="onCancel"
  >
    <template v-if="target">
      <h2 id="members-confirm-title">{{ confirmTitle(target) }}</h2>
      <p id="members-confirm-description">{{ confirmDescription(target) }}</p>
      <label :for="checkboxId">
        <input
          :id="checkboxId"
          type="checkbox"
          :checked="confirmed"
          :disabled="pending"
          @change="
            emit(
              'update:confirmed',
              ($event.target as HTMLInputElement).checked,
            )
          "
        />
        {{ confirmCheckboxLabel(target.kind) }}
      </label>
      <p role="status" aria-live="polite">{{ status }}</p>
      <div class="actions">
        <button
          type="button"
          :disabled="pending || !confirmed"
          @click="emit('confirm')"
        >
          {{ confirmButtonLabel(target.kind) }}
        </button>
        <button type="button" :disabled="pending" @click="emit('cancel')">
          Cancelar
        </button>
      </div>
    </template>
  </dialog>
</template>

<style scoped>
dialog {
  max-width: 28rem;
  padding: 1.25rem;
  border: 1px solid currentColor;
  font: inherit;
}
label {
  display: flex;
  gap: 0.5rem;
  align-items: flex-start;
  margin-block: 1rem;
  font-weight: 600;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}
button,
input {
  font: inherit;
  min-height: 2.75rem;
}
button {
  padding: 0.5rem 0.85rem;
  cursor: pointer;
}
button:disabled {
  cursor: not-allowed;
}
button:focus-visible,
input:focus-visible {
  outline: 3px solid currentColor;
  outline-offset: 3px;
}
</style>
