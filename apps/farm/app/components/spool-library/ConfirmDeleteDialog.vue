<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import Button from '../ui/Button.vue'
import Dialog from '../ui/Dialog.vue'

const props = defineProps<{
  title: string
  description: string
  confirmLabel?: string
  busy?: boolean
  error?: string
}>()

const open = defineModel<boolean>({ required: true })
const emit = defineEmits<{ confirm: [] }>()
const errorBox = ref<HTMLElement | null>(null)

watch(
  () => props.error,
  async (value) => {
    if (!value) return
    await nextTick()
    errorBox.value?.focus()
  },
)
</script>

<template>
  <Dialog v-model="open" :title="title">
    <div class="confirm-body">
      <p>{{ description }}</p>
      <div
        v-if="error"
        ref="errorBox"
        role="alert"
        tabindex="-1"
        class="dialog-error"
      >
        {{ error }}
      </div>
      <div class="dialog-actions">
        <Button :disabled="busy" @click="open = false">Cancelar</Button>
        <Button class="danger" :disabled="busy" @click="emit('confirm')">
          {{ busy ? 'Excluindo…' : (confirmLabel ?? 'Excluir') }}
        </Button>
      </div>
    </div>
  </Dialog>
</template>

<style scoped>
.confirm-body {
  display: grid;
  gap: var(--space-3);
}
.confirm-body p {
  margin: 0;
  overflow-wrap: anywhere;
}
.dialog-error {
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-inline-start: var(--space-1) solid var(--printer-error);
  border-radius: var(--radius-sm);
  color: var(--color-text);
}
.dialog-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
}
.danger {
  border-color: var(--printer-error);
  color: var(--printer-error);
  font-weight: var(--font-weight-semibold);
}
</style>
