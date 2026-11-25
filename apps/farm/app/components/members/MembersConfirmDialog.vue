<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import Button from '../ui/Button.vue'
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
  /** A failed action keeps the dialog open and says why inside it. */
  error?: string
}>()

const emit = defineEmits<{
  'update:confirmed': [value: boolean]
  confirm: []
  cancel: []
}>()

const dialog = ref<HTMLDialogElement | null>(null)
const errorBox = ref<HTMLElement | null>(null)
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

// Keyboard focus follows the failure message: the buttons were disabled while
// the request ran, so focus would otherwise fall back to the page behind.
watch(
  () => props.error,
  async (message) => {
    if (!message) return
    await nextTick()
    errorBox.value?.focus()
  },
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
      <p class="status" role="status" aria-live="polite">{{ status }}</p>
      <p v-if="error" ref="errorBox" class="error" role="alert" tabindex="-1">
        {{ error }}
      </p>
      <div class="actions">
        <Button
          :class="{ danger: target.kind !== 'role' }"
          :disabled="pending || !confirmed"
          @click="emit('confirm')"
        >
          {{ confirmButtonLabel(target.kind) }}
        </Button>
        <Button :disabled="pending" @click="emit('cancel')">Cancelar</Button>
      </div>
    </template>
  </dialog>
</template>

<style scoped>
dialog {
  box-sizing: border-box;
  inline-size: min(28rem, calc(100% - 2 * var(--space-4)));
  max-block-size: calc(100% - 2 * var(--space-4));
  overflow-y: auto;
  padding: var(--space-5);
  border: 1px solid var(--ops-border);
  border-radius: var(--ops-radius-lg);
  color: var(--ops-text);
  background: var(--ops-panel);
  overscroll-behavior: contain;
  font: inherit;
}
dialog::backdrop {
  background: rgb(0 0 0 / 55%);
}
h2 {
  margin: 0 0 var(--space-3);
  font-size: var(--ops-text-title);
  line-height: var(--line-height-tight);
  overflow-wrap: anywhere;
}
p {
  margin: 0;
  max-width: none;
  overflow-wrap: anywhere;
}
label {
  display: flex;
  gap: var(--space-3);
  align-items: flex-start;
  margin-block: var(--space-4);
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
}
input {
  flex: none;
  inline-size: 1.25rem;
  block-size: 1.25rem;
  margin: 0.125rem 0 0;
  accent-color: var(--color-accent);
}
.status {
  min-block-size: 1.5rem;
  color: var(--ops-muted);
}
.error {
  margin-block-end: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--ops-fault);
  border-radius: var(--ops-radius-sm);
  color: var(--ops-fault);
  background: var(--ops-fault-bg);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}
input:focus-visible,
.error:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
@media (max-width: 30rem) {
  dialog {
    padding: var(--space-4);
  }
  .actions > :deep(.ui-button) {
    flex: 1 1 100%;
  }
}
</style>
