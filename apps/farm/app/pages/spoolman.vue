<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import SpoolmanForm from '../components/spoolman/SpoolmanForm.vue'
import SpoolmanResults, {
  type SpoolmanSavedSetting,
} from '../components/spoolman/SpoolmanResults.vue'
import {
  configureSpoolmanOnConnectors,
  validateSpoolmanTargetInput,
  type SpoolmanConnectorResult,
} from '../utils/spoolman-onboarding.ts'
import {
  describeSpoolmanKeyState,
  loadSpoolmanBrowserKey,
  openSpoolmanSession,
  type SpoolmanKeyState,
} from '../utils/spoolman-setup-context.ts'

type Farm = { farmId: string }
type Connector = { agentId: string; status: 'pending' | 'approved' | 'revoked' }

const farms = ref<Farm[]>([])
const farmId = ref('')
const connectors = ref<Connector[]>([])
const settings = ref<SpoolmanSavedSetting[]>([])
const canManage = ref(false)
const keyState = ref<SpoolmanKeyState>({
  kind: 'unavailable',
  reason: 'missing',
})
const results = ref<SpoolmanConnectorResult[]>([])
const loading = ref(true)
const busy = ref(false)
const error = ref('')
const status = ref('')
const errorSummary = ref<HTMLElement | null>(null)
const origin = ref('')
const token = ref('')
const username = ref('')
const password = ref('')
let controller: AbortController | undefined

const approved = computed(() =>
  connectors.value.filter((connector) => connector.status === 'approved'),
)

function clearSecrets() {
  token.value = ''
  username.value = ''
  password.value = ''
}

async function fail(message: string) {
  error.value = message
  await nextTick()
  errorSummary.value?.focus()
}

async function refresh() {
  if (!farmId.value) return
  const signal = (controller = new AbortController()).signal
  const [list, inventory] = await Promise.all([
    $fetch<{ settings: SpoolmanSavedSetting[]; canManage: boolean }>(
      `/api/farms/${farmId.value}/spoolman`,
      { retry: 0, timeout: 15_000, signal },
    ),
    $fetch<{ connectors: Connector[] }>(
      `/api/farms/${farmId.value}/connectors`,
      { retry: 0, timeout: 15_000, signal },
    ),
  ])
  settings.value = list.settings
  canManage.value = list.canManage
  connectors.value = inventory.connectors
  if (list.canManage)
    keyState.value = await loadSpoolmanBrowserKey(farmId.value, signal)
}

onMounted(async () => {
  try {
    const page = await $fetch<{ farms: Farm[] }>('/api/farms', {
      query: { limit: 50 },
      retry: 0,
      timeout: 15_000,
    })
    farms.value = page.farms
    farmId.value = page.farms[0]?.farmId ?? ''
    if (!farmId.value) await fail('Nenhuma farm disponível.')
    else await refresh()
  } catch {
    await fail('Entre na sua conta para configurar o Spoolman.')
  } finally {
    loading.value = false
  }
})
onBeforeUnmount(() => {
  controller?.abort()
  clearSecrets()
})

async function submit() {
  if (busy.value || !farmId.value) return
  error.value = ''
  status.value = ''
  if (keyState.value.kind !== 'available')
    return fail(describeSpoolmanKeyState(keyState.value))
  const validated = validateSpoolmanTargetInput({
    origin: origin.value,
    token: token.value,
    username: username.value,
    password: password.value,
  })
  // Secrets live only inside `target` for the duration of the call.
  clearSecrets()
  if (!validated.ok) return fail(validated.error)
  busy.value = true
  results.value = []
  const key = keyState.value.key
  const farm = farmId.value
  const signal = (controller = new AbortController()).signal
  try {
    await configureSpoolmanOnConnectors({
      target: validated.target,
      agentIds: approved.value.map((connector) => connector.agentId),
      signal,
      openSession: (agentId, sessionSignal) =>
        openSpoolmanSession(farm, key, agentId, sessionSignal),
      report: async (result) => {
        await $fetch(`/api/farms/${farm}/spoolman`, {
          method: 'PUT',
          body: result,
          retry: 0,
          timeout: 15_000,
        })
      },
      onResult: (result) => {
        results.value = [...results.value, result]
      },
    })
    await refresh()
    status.value = 'Teste concluído. Veja o resultado de cada Connector abaixo.'
  } catch {
    await fail('Não foi possível concluir a configuração. Tente novamente.')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <main>
    <h1>Spoolman da farm</h1>
    <p>
      Configure um Spoolman para toda a farm. O endereço é enviado aos
      Connectors aprovados; as credenciais ficam somente neles.
    </p>
    <p v-if="loading" role="status">Carregando…</p>
    <div
      v-if="error"
      ref="errorSummary"
      role="alert"
      tabindex="-1"
      class="spoolman-error"
    >
      {{ error }}
    </div>
    <p v-if="status" role="status">{{ status }}</p>
    <template v-if="!loading && farmId">
      <p v-if="!canManage" role="status">
        Apenas proprietários e administradores configuram o Spoolman. Você pode
        consultar a situação abaixo.
      </p>
      <SpoolmanForm
        v-else
        v-model:origin="origin"
        v-model:token="token"
        v-model:username="username"
        v-model:password="password"
        :busy="busy"
        :connector-count="approved.length"
        @submit="submit"
      />
      <SpoolmanResults :settings="settings" :results="results" />
    </template>
  </main>
</template>
