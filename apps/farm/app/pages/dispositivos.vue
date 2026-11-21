<script setup lang="ts">
import {
  BrowserDeviceHttpListResponse,
  BrowserDeviceHttpFarmPageResponse,
} from '../../../../packages/farm-protocol/src/browser-device-http.ts'
import {
  createDeviceKey,
  listDeviceKeys,
  type LocalDeviceKey,
} from '../utils/device-key'
import Button from '../components/ui/Button.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import ErrorState from '../components/ui/ErrorState.vue'
import Skeleton from '../components/ui/Skeleton.vue'
import DeviceKeyList from '../components/onboarding/DeviceKeyList.vue'
import DeviceRecords from '../components/onboarding/DeviceRecords.vue'
import DeviceRecoveryNotes from '../components/onboarding/DeviceRecoveryNotes.vue'
import OnboardingField from '../components/onboarding/OnboardingField.vue'
import OnboardingPage from '../components/onboarding/OnboardingPage.vue'
import OnboardingPanel from '../components/onboarding/OnboardingPanel.vue'
import {
  readBrowserDeviceScope,
  proveBrowserDevice,
  decideBrowserDevice,
} from '../utils/browser-device-enrollment'

const farms = ref<
  ReturnType<typeof BrowserDeviceHttpFarmPageResponse.parse>['farms']
>([])
const nextFarm = ref<string | null>(null)
const farmId = ref('')
const page = ref<BrowserDeviceHttpListResponse | null>(null)
const keys = shallowRef<LocalDeviceKey[]>([])
const busy = ref(false)
const error = ref('')
const message = ref('')
const confirmation = ref('')
const shell = ref<InstanceType<typeof OnboardingPage> | null>(null)
const errorSummary = ref<HTMLElement | null>(null)
let generation = 0
let controller = new AbortController()
const admin = computed(
  () => page.value && ['owner', 'admin'].includes(page.value.currentRole),
)
function cancel() {
  generation++
  controller.abort()
  controller = new AbortController()
  page.value = null
  keys.value = []
  confirmation.value = ''
  busy.value = false
}
function clear() {
  cancel()
  farms.value = []
  farmId.value = ''
  nextFarm.value = null
}
function failure(cause: unknown) {
  const status =
    cause && typeof cause === 'object' && 'statusCode' in cause
      ? cause.statusCode
      : undefined
  clear()
  error.value =
    status === 404
      ? 'O cadastro de dispositivos está desativado neste ambiente.'
      : status === 401 || status === 403
        ? 'Sua autorização mudou. Entre novamente e atualize suas farms.'
        : 'A operação não foi confirmada. Atualize a consulta antes de tentar outra ação. Se a chave foi criada, ela permanece neste navegador.'
  void nextTick(() => errorSummary.value?.focus())
}
async function loadFarms(after?: string) {
  clear()
  const token = generation
  busy.value = true
  error.value = ''
  message.value = ''
  try {
    await $fetch('/api/auth/me', {
      signal: controller.signal,
      retry: 0,
      timeout: 15000,
    })
    const result = BrowserDeviceHttpFarmPageResponse.parse(
      await $fetch('/api/farms', {
        query: { limit: 20, ...(after ? { after } : {}) },
        signal: controller.signal,
        retry: 0,
        timeout: 15000,
      }),
    )
    if (token !== generation) return
    farms.value = result.farms
    nextFarm.value = result.nextAfter
  } catch (cause) {
    if (token === generation) failure(cause)
  } finally {
    if (token === generation) busy.value = false
  }
}
async function loadDevices(after?: string) {
  const selected = farmId.value
  cancel()
  if (!selected) return
  const token = generation
  busy.value = true
  error.value = ''
  message.value = ''
  try {
    const result = await readBrowserDeviceScope(
      selected,
      controller.signal,
      after,
    )
    const local = await listDeviceKeys({
      farmId: selected,
      accountId: result.currentAccountId,
    })
    const fresh = await readBrowserDeviceScope(
      selected,
      controller.signal,
      after,
    )
    if (token !== generation || selected !== farmId.value) return
    if (result.currentAccountId !== fresh.currentAccountId)
      throw new Error('Conta alterada')
    page.value = fresh
    keys.value = local
  } catch (cause) {
    if (token === generation) {
      page.value = null
      keys.value = []
      failure(cause)
    }
  } finally {
    if (token === generation) busy.value = false
  }
}
async function enroll(
  key?: LocalDeviceKey,
  purpose: 'enroll' | 'recover' = 'enroll',
) {
  const snapshot = page.value
  if (!snapshot || busy.value) return
  const scope = { farmId: farmId.value, accountId: snapshot.currentAccountId }
  const token = generation
  const signal = controller.signal
  const isCurrent = () => token === generation && scope.farmId === farmId.value
  busy.value = true
  error.value = ''
  message.value = ''
  try {
    const fresh = await readBrowserDeviceScope(scope.farmId, signal)
    if (!isCurrent() || fresh.currentAccountId !== scope.accountId)
      throw new Error('Conta alterada')
    const local = key ?? (await createDeviceKey(scope))
    if (!isCurrent()) return
    const result = await proveBrowserDevice({
      scope,
      key: local,
      purpose,
      signal,
      isCurrent,
    })
    if (!isCurrent()) return
    await loadDevices()
    if (
      !page.value ||
      page.value.currentAccountId !== scope.accountId ||
      farmId.value !== scope.farmId
    )
      return
    message.value =
      result.device.status === 'approved'
        ? 'Posse confirmada nesta sessão. O registro continua sujeito à autorização atual.'
        : 'Posse confirmada. Aguarde aprovação explícita de proprietário ou administrador.'
  } catch (cause) {
    if (isCurrent()) {
      page.value = null
      keys.value = []
      failure(cause)
    }
  } finally {
    if (isCurrent()) busy.value = false
  }
}
async function decide(
  device: BrowserDeviceHttpListResponse['devices'][number],
  operation: 'approve' | 'revoke',
) {
  const snapshot = page.value
  if (!snapshot || busy.value || confirmation.value !== device.thumbprint)
    return
  const selected = farmId.value
  const token = generation
  busy.value = true
  error.value = ''
  message.value = ''
  try {
    await decideBrowserDevice({
      farmId: selected,
      accountId: snapshot.currentAccountId,
      device,
      operation,
      signal: controller.signal,
      isCurrent: () => token === generation && selected === farmId.value,
    })
    if (token !== generation) return
    await loadDevices()
    if (
      !page.value ||
      page.value.currentAccountId !== snapshot.currentAccountId ||
      farmId.value !== selected
    )
      return
    message.value =
      operation === 'revoke'
        ? 'Dispositivo revogado definitivamente.'
        : 'Dispositivo aprovado.'
  } catch (cause) {
    if (token === generation) {
      page.value = null
      keys.value = []
      failure(cause)
    }
  } finally {
    if (token === generation) busy.value = false
  }
}
onMounted(() => {
  shell.value?.focusHeading()
  void loadFarms()
})
onBeforeUnmount(clear)
onBeforeRouteLeave(clear)
</script>

<template>
  <OnboardingPage ref="shell" title="Dispositivos do navegador">
    <template #intro>
      <p>
        Cadastre uma chave deste navegador para sua conta e farm. A consulta não
        cria chaves nem concede aprovação. Este registro não estabelece conexão
        com impressoras.
      </p>
    </template>
    <nav class="links" aria-label="Conta">
      <NuxtLink to="/">Início</NuxtLink>
      <NuxtLink to="/sair">Sair da conta</NuxtLink>
    </nav>
    <div ref="errorSummary" class="alert" role="alert" tabindex="-1">
      <ErrorState
        v-if="error"
        title="Operação não confirmada"
        :description="error"
      >
        <Button @click="loadFarms()">Tentar novamente</Button>
      </ErrorState>
    </div>
    <p role="status" class="status">
      {{ busy && page ? 'Aguarde…' : busy ? '' : message }}
    </p>
    <OnboardingPanel v-if="busy && !page" busy>
      <p role="status">Carregando farms e dispositivos…</p>
      <div class="skeletons"><Skeleton /><Skeleton /><Skeleton /></div>
    </OnboardingPanel>
    <OnboardingPanel heading-id="farms-heading" title="Suas farms" :busy="busy">
      <OnboardingField id="device-farm" label="Farm">
        <select id="device-farm" v-model="farmId" @change="loadDevices()">
          <option value="">Selecione</option>
          <option v-for="farm in farms" :key="farm.farmId" :value="farm.farmId">
            {{ farm.farmId }}
          </option>
        </select>
      </OnboardingField>
      <div class="actions">
        <Button :disabled="busy" @click="loadFarms()">Atualizar farms</Button>
        <Button v-if="nextFarm" :disabled="busy" @click="loadFarms(nextFarm)">
          Próxima página de farms
        </Button>
        <Button v-if="farmId" :disabled="busy" @click="loadDevices()">
          Atualizar dispositivos
        </Button>
      </div>
      <EmptyState
        v-if="!busy && !farms.length && !error"
        :level="3"
        title="Nenhuma farm disponível"
        description="Sua conta ainda não tem acesso a uma farm. Peça um convite a uma proprietária ou a um proprietário e atualize as farms."
      />
    </OnboardingPanel>
    <template v-if="page">
      <DeviceKeyList
        :account-id="page.currentAccountId"
        :keys="keys"
        :devices="page.devices"
        :busy="busy"
        @create="enroll()"
        @enroll="(key, purpose) => enroll(key, purpose)"
      />
      <DeviceRecords
        v-model:confirmation="confirmation"
        :devices="page.devices"
        :next-after="page.nextAfter"
        :admin="Boolean(admin)"
        :busy="busy"
        @decide="decide"
        @next="loadDevices(page.nextAfter ?? undefined)"
      />
    </template>
    <DeviceRecoveryNotes />
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
.status {
  margin: 0;
  color: var(--color-text-muted);
}
.status:empty {
  display: none;
}
.skeletons {
  display: grid;
  gap: var(--space-3);
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
