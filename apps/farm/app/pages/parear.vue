<script setup lang="ts">
import { useFarmRoute } from '../composables/useFarmRoute.ts'
import { fetchFarmSelectionPage } from '../composables/useFarmMemberships.ts'
import { resolveFarmScope } from '../utils/farm-scope.ts'
import {
  normalizePairingCode,
  PairingApprovalRequest,
} from '@open3dfarmmanager/farm-protocol'
import Button from '../components/ui/Button.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import ErrorState from '../components/ui/ErrorState.vue'
import Skeleton from '../components/ui/Skeleton.vue'
import OnboardingField from '../components/onboarding/OnboardingField.vue'
import OnboardingNotice from '../components/onboarding/OnboardingNotice.vue'
import OnboardingPage from '../components/onboarding/OnboardingPage.vue'
import OnboardingPanel from '../components/onboarding/OnboardingPanel.vue'
const farms = ref<{ farmId: string }[]>([])
const farmId = ref('')
const { route, setFarmScope } = useFarmRoute()
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
    const page = await fetchFarmSelectionPage(route.query.farm, {
      signal: controller.signal,
    })
    if (current !== generation) return
    farms.value = page.farms
    farmId.value =
      resolveFarmScope(page.farms, route.query.farm, !!page.nextAfter)
        ?.farmId ?? ''
    ready.value = true
    nextFarm.value = page.nextAfter ?? null
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
watch(
  () => route.query.farm,
  (requested) => {
    farmId.value =
      resolveFarmScope(farms.value, requested, !!nextFarm.value)?.farmId ?? ''
    confirmed.value = false
  },
)
function switchFarm() {
  confirmed.value = false
  void setFarmScope(farmId.value)
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
  <OnboardingPage title="Aprovar Connector">
    <template #intro>
      <p>
        Somente proprietários e administradores podem aprovar. Compare a
        impressão digital completa com a exibida no Connector que você está
        configurando.
      </p>
    </template>
    <nav class="links" aria-label="Conta">
      <NuxtLink to="/connectors">Inventário e recuperação</NuxtLink>
      <NuxtLink to="/entrar">Entrar na conta</NuxtLink>
    </nav>
    <OnboardingNotice tone="warning">
      <p>
        A confirmação de identidade dura até 60 segundos, incluindo a aprovação
        e a conclusão no Connector. Prepare este formulário antes de confirmar a
        identidade no Connector. Se o prazo terminar, inicie um novo pareamento.
      </p>
    </OnboardingNotice>
    <div
      ref="summary"
      class="alert"
      :role="failed ? 'alert' : 'status'"
      tabindex="-1"
    >
      <ErrorState
        v-if="failed"
        title="Pareamento não concluído"
        :description="message"
      >
        <Button @click="start()">Recarregar formulário</Button>
      </ErrorState>
      <OnboardingNotice v-else-if="message"
        ><p>{{ message }}</p></OnboardingNotice
      >
    </div>
    <OnboardingPanel v-if="loading" busy>
      <p role="status">Carregando suas farms…</p>
      <div class="skeletons"><Skeleton /><Skeleton /><Skeleton /></div>
    </OnboardingPanel>
    <EmptyState
      v-else-if="ready && !pending && !farms.length && !nextFarm"
      title="Nenhuma farm disponível"
      description="Sua conta não tem uma farm para aprovar Connectors. Entre com uma conta de proprietário ou administrador de uma farm."
    >
      <NuxtLink to="/entrar">Usar outra conta</NuxtLink>
    </EmptyState>
    <OnboardingPanel
      v-else
      heading-id="pairing-heading"
      title="Dados do Connector"
      :busy="pending"
    >
      <form class="form" :aria-busy="pending" @submit.prevent="approve">
        <OnboardingField
          id="pairing-farm"
          label="Farm de destino"
          help="A farm que receberá este Connector."
          v-slot="{ describedBy }"
        >
          <select
            id="pairing-farm"
            v-model="farmId"
            :aria-describedby="describedBy"
            :disabled="!ready || pending"
            required
            @change="switchFarm"
          >
            <option value="">Selecione</option>
            <option
              v-for="farm in farms"
              :key="farm.farmId"
              :value="farm.farmId"
            >
              {{ farm.farmId }}
            </option>
          </select>
        </OnboardingField>
        <div v-if="nextFarm" class="actions">
          <Button :disabled="pending || !ready" @click="nextFarmPage">
            Próxima página de farms
          </Button>
        </div>
        <OnboardingField
          id="pairing-code"
          label="Código exibido no Connector"
          help="Digite o código de pareamento mostrado no Connector."
          v-slot="{ describedBy }"
        >
          <input
            id="pairing-code"
            v-model="code"
            maxlength="32"
            autocomplete="off"
            spellcheck="false"
            :aria-describedby="describedBy"
            :disabled="!ready || pending"
            required
            @input="confirmed = false"
          />
        </OnboardingField>
        <OnboardingField
          id="pairing-fingerprint"
          label="Impressão digital exibida no Connector"
          help="Copie a impressão digital completa, inclusive o prefixo SHA256:."
          v-slot="{ describedBy }"
        >
          <input
            id="pairing-fingerprint"
            v-model="fingerprint"
            class="mono"
            maxlength="50"
            autocomplete="off"
            spellcheck="false"
            :aria-describedby="describedBy"
            :disabled="!ready || pending"
            required
            @input="confirmed = false"
          />
        </OnboardingField>
        <label class="check"
          ><input
            v-model="confirmed"
            type="checkbox"
            :disabled="!ready || pending"
          />
          <span
            >Conferi a impressão digital completa e a farm de destino.</span
          ></label
        >
        <div class="actions">
          <Button type="submit" :disabled="!ready || pending || !confirmed">
            {{ pending ? 'Aprovando…' : 'Aprovar Connector' }}
          </Button>
        </div>
      </form>
    </OnboardingPanel>
  </OnboardingPage>
</template>
<style scoped>
.links {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
}
.alert:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
  border-radius: var(--radius-md);
}
.alert:empty {
  display: none;
}
.alert :deep(.ui-card) {
  border: 1px solid var(--color-border);
  box-shadow: none;
}
.skeletons {
  display: grid;
  gap: var(--space-3);
}
.form {
  display: grid;
  gap: var(--space-4);
  max-width: 34rem;
}
.mono {
  font-family: ui-monospace, monospace;
}
.check {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  min-height: 2.75rem;
}
.check input {
  flex: none;
  inline-size: 1.5rem;
  block-size: 1.5rem;
  margin: 0;
  accent-color: var(--color-accent);
}
.check input:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
}
@media (max-width: 30rem) {
  .actions :deep(.ui-button) {
    width: 100%;
  }
}
</style>
