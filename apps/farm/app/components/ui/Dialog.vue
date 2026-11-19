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

function syncClosed() {
  if (!dialog.value?.open) open.value = false
}
</script>

<template>
  <dialog ref="dialog" :aria-labelledby="titleId" @close="syncClosed">
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
