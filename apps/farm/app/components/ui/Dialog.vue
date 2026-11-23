<script setup lang="ts">
import { useId, useTemplateRef, watchPostEffect } from 'vue'
import IconButton from './IconButton.vue'

defineProps<{ title: string }>()
const open = defineModel<boolean>({ required: true })
const dialog = useTemplateRef<HTMLDialogElement>('dialog')
const titleId = useId()

watchPostEffect(() => {
  const element = dialog.value
  if (!element || element.open === open.value) return
  if (open.value) element.showModal()
  else element.close()
})

function containFocus(event: KeyboardEvent) {
  if (event.key !== 'Tab' || !dialog.value) return
  const controls = [
    ...dialog.value.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((element) => element.getClientRects().length > 0)
  if (!controls.length) {
    event.preventDefault()
    dialog.value.focus()
    return
  }
  const first = controls[0]!
  const last = controls[controls.length - 1]!
  if (
    event.shiftKey &&
    (document.activeElement === first ||
      !dialog.value.contains(document.activeElement))
  ) {
    event.preventDefault()
    last.focus()
  } else if (
    !event.shiftKey &&
    (document.activeElement === last ||
      !dialog.value.contains(document.activeElement))
  ) {
    event.preventDefault()
    first.focus()
  }
}

function syncClosed() {
  if (!dialog.value?.open) open.value = false
}
</script>

<template>
  <dialog
    ref="dialog"
    :aria-labelledby="titleId"
    @close="syncClosed"
    @keydown="containFocus"
  >
    <h2 :id="titleId">{{ title }}</h2>
    <slot />
    <IconButton label="Fechar" icon="close" @click="open = false" />
  </dialog>
</template>

<style scoped>
dialog {
  max-inline-size: min(32rem, calc(100% - 2 * var(--space-4)));
  border: 1px solid var(--text-muted);
  border-radius: var(--radius-sm);
  padding: var(--space-6);
  color: var(--text);
  background: var(--surface-raised);
}
dialog::backdrop {
  background: rgb(0 0 0 / 55%);
}
</style>
