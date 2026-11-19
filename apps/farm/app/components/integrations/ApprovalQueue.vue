<script setup lang="ts">
import { formatDateTime } from '../../utils/ui-format.ts'
import type { HeldItemRow } from './approval-types.ts'

defineProps<{
  items: HeldItemRow[]
  /** The id being decided now; its buttons stay disabled. */
  busyId?: string
  message?: string
}>()
defineEmits<{
  (event: 'decide', id: string, decision: 'approve' | 'reject'): void
}>()

const KIND_LABEL = { job: 'Trabalho de impressão', action: 'Ação' } as const
function when(value: number) {
  return formatDateTime(value, 'short-utc') ?? 'Indisponível'
}
</script>

<template>
  <section aria-labelledby="approval-heading">
    <h2 id="approval-heading">Aprovações pendentes</h2>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="items.length === 0">Nenhuma solicitação aguardando aprovação.</p>
    <ul v-else class="approval-list">
      <li v-for="item in items" :key="item.id">
        <p>
          <strong>{{ KIND_LABEL[item.kind] }}</strong>: {{ item.summary }}
        </p>
        <p>Aplicativo {{ item.appName }} · Impressora {{ item.printerKey }}</p>
        <p>
          Solicitado em {{ when(item.createdAt) }} UTC · expira em
          {{ when(item.expiresAt) }} UTC
        </p>
        <div class="actions">
          <button
            type="button"
            :disabled="busyId === item.id"
            :aria-label="`Aprovar ${item.summary}`"
            @click="$emit('decide', item.id, 'approve')"
          >
            Aprovar
          </button>
          <button
            type="button"
            :disabled="busyId === item.id"
            :aria-label="`Rejeitar ${item.summary}`"
            @click="$emit('decide', item.id, 'reject')"
          >
            Rejeitar
          </button>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.approval-list {
  display: grid;
  gap: 0.75rem;
  padding: 0;
  list-style: none;
}
.approval-list li {
  padding: 0.75rem;
  border: 1px solid currentColor;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}
button {
  min-height: 2.75rem;
  padding: 0.5rem 1rem;
}
:focus-visible {
  outline: 3px solid currentColor;
  outline-offset: 2px;
}
</style>
