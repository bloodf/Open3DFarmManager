<script setup lang="ts">
import {
  normalizePairingCode,
  PairingApprovalRequest,
} from '@open3dfarmmanager/farm-protocol'
import Button from '../components/ui/Button.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import ErrorState from '../components/ui/ErrorState.vue'
import Skeleton from '../components/ui/Skeleton.vue'
const farms = ref<{ farmId: string }[]>([])
const farmId = ref('')
const nextFarm = ref<string | null>(null)
const code = ref('')
const fingerprint = ref('')
const confirmed = ref(false)
const ready = ref(false)
const pending = ref(false)
const loading = ref(true)
const failed = ref(false)
const message = ref('')
const summary = ref<HTMLElement | null>(null)
let generation = 0
let controller: AbortController | undefined
function clear() {
  generation++
  controller?.abort()
  farms.value = []
  farmId.value = ''
  nextFarm.value = null
  code.value = ''
  fingerprint.value = ''
  confirmed.value = false
  ready.value = false
  pending.value = false
}
async function start() {
  loading.value = true
  failed.value = false
  message.value = ''
  const current = generation
  controller = new AbortController()
  try {
    await $fetch('/api/connector-pairing/capability', {
      signal: controller.signal,
      retry: 0,
      timeout: 10000,
    })
    const page = await $fetch<{
      farms: { farmId: string }[]
      nextAfter: string | null
    }>('/api/farms', {
      signal: controller.signal,
      query: { limit: 50 },
      retry: 0,
      timeout: 10000,
    })
    if (current !== generation) return
    farms.value = page.farms
    ready.value = true
    nextFarm.value = page.nextAfter
  } catch {
    if (current !== generation) return
    clear()
    failed.value = true
    message.value =
      'Pareamento indisponível. Entre na sua conta e tente novamente.'
  } finally {
    loading.value = false
  }
}
onMounted(start)
async function nextFarmPage() {
  if (!nextFarm.value || pending.value || !ready.value) return
  const current = generation
  const after = nextFarm.value
  pending.value = true
  farmId.value = ''
  farms.value = []
  confirmed.value = false
  try {
    const page = await $fetch<{
      farms: { farmId: string }[]
      nextAfter: string | null
    }>('/api/farms', {
      query: { limit: 50, after },
      signal: controller?.signal,
      retry: 0,
      timeout: 10000,
    })
    if (current !== generation) return
    farms.value = page.farms
    nextFarm.value = page.nextAfter
  } catch {
    if (current !== generation) return
    clear()
    failed.value = true
    message.value =
      'Não foi possível consultar suas farms. Entre novamente antes de continuar.'
  } finally {
    if (current === generation) pending.value = false
  }
}
async function approve() {
  if (!ready.value || pending.value || !confirmed.value) return
  let request
  try {
    request = PairingApprovalRequest.parse({
      user_code: normalizePairingCode(code.value),
      farm_id: farmId.value,
      expected_fingerprint: fingerprint.value.trim(),
    })
  } catch {
    message.value =
      'Confira a farm, o código e a impressão digital exibidos no Connector.'
    await nextTick()
    summary.value?.focus()
    return
  }
  const current = generation
  pending.value = true
  message.value = ''
  failed.value = false
  try {
    await $fetch('/api/connector-pairing/approve', {
      method: 'POST',
      body: request,
      signal: controller?.signal,
      retry: 0,
      timeout: 10000,
    })
    if (current !== generation) return
    clear()
    message.value =
      'Connector aprovado. Conclua o pareamento no Connector agora. Se a confirmação não chegar, consulte o inventário para revogar este registro e inicie um novo pareamento.'
  } catch {
    if (current !== generation) return
    clear()
    failed.value = true
    message.value =
      'Não foi possível confirmar a aprovação. Consulte o inventário antes de tentar novamente. Se o prazo terminou, revogue o registro aprovado, caso exista, e inicie um novo pareamento no Connector.'
  } finally {
    pending.value = false
    await nextTick()
    summary.value?.focus()
  }
}
onBeforeUnmount(clear)
onBeforeRouteLeave(clear)
</script>
<template>
  <main id="conteudo">
    <h1>Aprovar Connector</h1>
    <nav aria-label="Conta">
      <NuxtLink to="/connectors">Inventário e recuperação</NuxtLink> ·
      <NuxtLink to="/entrar">Entrar na conta</NuxtLink>
    </nav>
    <p>
      Somente proprietários e administradores podem aprovar. Compare a impressão
      digital completa com a exibida no Connector que você está configurando.
    </p>
    <p>
      A confirmação de identidade dura até 60 segundos, incluindo a aprovação e
      a conclusão no Connector. Prepare este formulário antes de confirmar a
      identidade no Connector. Se o prazo terminar, inicie um novo pareamento.
    </p>
    <div ref="summary" :role="failed ? 'alert' : 'status'" tabindex="-1">
      <ErrorState
        v-if="failed"
        title="Pareamento não concluído"
        :description="message"
      >
        <Button @click="start()">Recarregar formulário</Button>
      </ErrorState>
      <p v-else>{{ message }}</p>
    </div>
    <div v-if="loading" aria-busy="true">
      <p role="status">Carregando suas farms…</p>
      <Skeleton /><Skeleton /><Skeleton />
    </div>
    <EmptyState
      v-else-if="ready && !pending && !farms.length && !nextFarm"
      title="Nenhuma farm disponível"
      description="Sua conta não tem uma farm para aprovar Connectors. Entre com uma conta de proprietário ou administrador de uma farm."
    >
      <NuxtLink to="/entrar">Usar outra conta</NuxtLink>
    </EmptyState>
    <form v-else :aria-busy="pending" @submit.prevent="approve">
      <label for="pairing-farm">Farm de destino</label>
      <select
        id="pairing-farm"
        v-model="farmId"
        :disabled="!ready || pending"
        required
        @change="confirmed = false"
      >
        <option value="">Selecione</option>
        <option v-for="farm in farms" :key="farm.farmId" :value="farm.farmId">
          {{ farm.farmId }}
        </option>
      </select>
      <button
        v-if="nextFarm"
        type="button"
        :disabled="pending || !ready"
        @click="nextFarmPage"
      >
        Próxima página de farms
      </button>
      <label for="pairing-code">Código exibido no Connector</label>
      <input
        id="pairing-code"
        v-model="code"
        maxlength="32"
        autocomplete="off"
        spellcheck="false"
        :disabled="!ready || pending"
        required
        @input="confirmed = false"
      />
      <label for="pairing-fingerprint"
        >Impressão digital exibida no Connector</label
      >
      <input
        id="pairing-fingerprint"
        v-model="fingerprint"
        maxlength="50"
        autocomplete="off"
        spellcheck="false"
        :disabled="!ready || pending"
        required
        @input="confirmed = false"
      />
      <label
        ><input
          v-model="confirmed"
          type="checkbox"
          :disabled="!ready || pending"
        />
        Conferi a impressão digital completa e a farm de destino.</label
      >
      <button type="submit" :disabled="!ready || pending || !confirmed">
        {{ pending ? 'Aprovando…' : 'Aprovar Connector' }}
      </button>
    </form>
  </main>
</template>
<style scoped>
label {
  display: block;
  margin-top: 1rem;
}
input,
select,
button {
  font: inherit;
  min-height: 2.75rem;
  max-width: 100%;
}
input:not([type='checkbox']) {
  width: 100%;
}
:focus-visible {
  outline: 3px solid currentColor;
  outline-offset: 3px;
}
</style>
