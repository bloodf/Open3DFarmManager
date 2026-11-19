<script setup lang="ts">
import { computed, useId, useTemplateRef } from 'vue'
import Button from './Button.vue'

const props = defineProps<{
  label: string
  tabs: readonly { id: string; label: string }[]
}>()
const selected = defineModel<string>()
const active = computed(
  () =>
    props.tabs.find((tab) => tab.id === selected.value)?.id ??
    props.tabs[0]?.id,
)
const baseId = useId()
const tablist = useTemplateRef<HTMLDivElement>('tablist')

function move(event: KeyboardEvent, index: number) {
  const length = props.tabs.length
  const target = {
    ArrowLeft: (index + length - 1) % length,
    ArrowRight: (index + 1) % length,
    Home: 0,
    End: length - 1,
  }[event.key]
  if (target === undefined) return
  const tab = props.tabs[target]
  if (!tab) return
  event.preventDefault()
  selected.value = tab.id
  tablist.value
    ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    [target]?.focus()
}
</script>

<template>
  <div ref="tablist" role="tablist" :aria-label="label" class="tabs">
    <Button
      v-for="(tab, index) in tabs"
      :id="`${baseId}-tab-${index}`"
      :key="tab.id"
      role="tab"
      :aria-controls="`${baseId}-panel-${index}`"
      :aria-selected="active === tab.id"
      :tabindex="active === tab.id ? 0 : -1"
      @click="selected = tab.id"
      @keydown="move($event, index)"
    >
      {{ tab.label }}
    </Button>
  </div>
  <div
    v-for="(tab, index) in tabs"
    v-show="active === tab.id"
    :id="`${baseId}-panel-${index}`"
    :key="tab.id"
    role="tabpanel"
    :aria-labelledby="`${baseId}-tab-${index}`"
    tabindex="0"
  >
    <slot :name="tab.id" />
  </div>
</template>

<style scoped>
.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-block-end: var(--space-3);
}
[aria-selected='true'] {
  color: var(--surface-raised);
  background: var(--accent);
}
[role='tabpanel']:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-offset);
}
</style>
