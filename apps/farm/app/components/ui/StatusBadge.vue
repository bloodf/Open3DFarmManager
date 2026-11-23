<script setup lang="ts">
import { computed } from 'vue'
const props = defineProps<{
  tone:
    | 'idle'
    | 'printing'
    | 'paused'
    | 'error'
    | 'offline'
    | 'stale'
    | 'attention'
    | 'fault'
    | 'maintenance'
  label: string
}>()
const aliases: Partial<Record<typeof props.tone, string>> = {
  paused: 'attention',
  error: 'fault',
  stale: 'offline',
}
const role = computed(() => aliases[props.tone] ?? props.tone)
const icons: Record<string, string> = {
  printing: '▶',
  attention: '!',
  fault: '×',
  maintenance: '◆',
  idle: '○',
  offline: '∕',
}
const icon = computed(() => icons[role.value])
</script>

<template>
  <span class="badge" :class="`badge--${role}`"
    ><span aria-hidden="true">{{ icon }}</span> {{ label }}</span
  >
</template>

<style scoped>
.badge {
  display: inline-flex;
  align-items: center;
  gap: var(--ops-space-1);
  border: 1px solid currentColor;
  border-radius: var(--ops-radius-sm);
  padding: var(--ops-space-1) var(--ops-space-2);
  font-size: var(--ops-text-small);
  font-weight: 600;
}
.badge--printing {
  color: var(--ops-printing);
  background: var(--ops-printing-bg);
}
.badge--attention {
  color: var(--ops-attention);
  background: var(--ops-attention-bg);
}
.badge--fault {
  color: var(--ops-fault);
  background: var(--ops-fault-bg);
}
.badge--maintenance {
  color: var(--ops-maintenance);
  background: var(--ops-maintenance-bg);
}
.badge--idle {
  color: var(--ops-idle);
  background: var(--ops-idle-bg);
}
.badge--offline {
  color: var(--ops-offline);
  background: var(--ops-offline-hatch);
}
</style>
