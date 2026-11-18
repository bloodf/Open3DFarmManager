<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import ApprovalQueue from './ApprovalQueue.vue'
import type { HeldItemRow } from './approval-types.ts'

const props = defineProps<{ farmId: string }>()

const items = ref<HeldItemRow[]>([])
const message = ref('')
const busyId = ref('')
/** A viewer holds no control rights: the panel stays hidden for them. */
const allowed = ref(false)

const DONE: Record<string, string> = {
  approve: 'Solicitação aprovada e enviada para entrega.',
  reject: 'Solicitação rejeitada.',
}

function statusOf(cause: unknown) {
  return cause && typeof cause === 'object' && 'statusCode' in cause
    ? Number(cause.statusCode)
    : 0
}
function problemMessage(cause: unknown) {
  const data =
    cause && typeof cause === 'object' && 'data' in cause
      ? (cause.data as { message?: unknown } | undefined)
      : undefined
  return typeof data?.message === 'string'
    ? data.message
    : 'Não foi possível concluir a decisão.'
}

async function load() {
  try {
    const result = await $fetch<{ items: HeldItemRow[] }>(
      `/api/farms/${props.farmId}/integrations/approvals`,
      { retry: 0 },
    )
    items.value = result.items
    allowed.value = true
  } catch (cause) {
    items.value = []
    allowed.value = false
    if (![401, 403].includes(statusOf(cause)))
      message.value = 'Não foi possível carregar as aprovações pendentes.'
  }
}
async function decide(id: string, decision: 'approve' | 'reject') {
  busyId.value = id
  message.value = ''
  try {
    await $fetch(
      `/api/farms/${props.farmId}/integrations/approvals/${id}/decision`,
      { method: 'POST', body: { decision }, retry: 0 },
    )
    message.value = DONE[decision] ?? ''
  } catch (cause) {
    message.value = problemMessage(cause)
  } finally {
    busyId.value = ''
    await load()
  }
}
onMounted(load)
watch(() => props.farmId, load)
</script>

<template>
  <ApprovalQueue
    v-if="allowed || message"
    :items="items"
    :busy-id="busyId"
    :message="message"
    @decide="decide"
  />
</template>
