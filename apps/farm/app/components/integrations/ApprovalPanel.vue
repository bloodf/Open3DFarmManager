<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { createLatestRequestGuard } from '../ui-misc-guards.ts'
import ApprovalQueue from './ApprovalQueue.vue'
import type { HeldItemRow } from './approval-types.ts'

const props = defineProps<{ farmId: string }>()

const items = ref<HeldItemRow[]>([])
const message = ref('')
const busyId = ref('')
/** A viewer holds no control rights: the panel stays hidden for them. */
const allowed = ref(false)
const requests = createLatestRequestGuard()

const DONE: Record<string, string> = {
  approve: 'Solicitação aprovada e enviada para entrega.',
  reject: 'Solicitação rejeitada.',
}

function statusOf(cause: unknown) {
  return cause && typeof cause === 'object' && 'statusCode' in cause
    ? Number(cause.statusCode)
    : 0
}
// Never show the server message: it may carry internal details.
function problemMessage(_cause: unknown) {
  return 'Não foi possível concluir a decisão. Tente novamente.'
}

async function load() {
  const request = requests.next()
  const farmId = props.farmId
  message.value = ''
  items.value = []
  allowed.value = false
  busyId.value = ''
  try {
    const result = await $fetch<{ items: HeldItemRow[] }>(
      `/api/farms/${farmId}/integrations/approvals`,
      { retry: 0 },
    )
    if (!requests.isCurrent(request) || props.farmId !== farmId) return
    items.value = result.items
    allowed.value = true
  } catch (cause) {
    if (!requests.isCurrent(request) || props.farmId !== farmId) return
    items.value = []
    allowed.value = false
    if (![401, 403].includes(statusOf(cause)))
      message.value = 'Não foi possível carregar as aprovações pendentes.'
  }
}
async function decide(id: string, decision: 'approve' | 'reject') {
  const request = requests.next()
  const farmId = props.farmId
  busyId.value = id
  message.value = ''
  try {
    await $fetch(`/api/farms/${farmId}/integrations/approvals/${id}/decision`, {
      method: 'POST',
      body: { decision },
      retry: 0,
    })
    if (requests.isCurrent(request) && props.farmId === farmId)
      message.value = DONE[decision] ?? ''
  } catch (cause) {
    if (requests.isCurrent(request) && props.farmId === farmId)
      message.value = problemMessage(cause)
  } finally {
    if (requests.isCurrent(request) && props.farmId === farmId) {
      busyId.value = ''
      await load()
    }
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
