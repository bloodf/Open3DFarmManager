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
const heading = ref<HTMLElement | null>(null)
const errorSummary = ref<HTMLElement | null>(null)
let generation = 0
let controller = new AbortController()
const statusLabel = {
  pending: 'Pendente',
  approved: 'Aprovado',
  revoked: 'Revogado',
}
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
function localRegistration(key: LocalDeviceKey) {
  return page.value?.devices.find(
    (device) =>
      device.thumbprint === key.thumbprint &&
      device.accountId === page.value?.currentAccountId,
  )
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
function date(value: number) {
  return new Date(value).toLocaleString('pt-BR')
}
onMounted(() => {
  heading.value?.focus()
  void loadFarms()
})
onBeforeUnmount(clear)
onBeforeRouteLeave(clear)
</script>

<template>
  <main id="conteudo">
    <small>Open3DFarmManager</small>
    <h1 ref="heading" tabindex="-1">Dispositivos do navegador</h1>
    <nav aria-label="Conta">
      <NuxtLink to="/">Início</NuxtLink> ·
      <NuxtLink to="/sair">Sair da conta</NuxtLink>
    </nav>
    <p>
      Cadastre uma chave deste navegador para sua conta e farm. A consulta não
      cria chaves nem concede aprovação. Este registro não estabelece conexão
      com impressoras.
    </p>
    <p ref="errorSummary" role="alert" tabindex="-1">{{ error }}</p>
    <p role="status">{{ busy ? 'Aguarde…' : message }}</p>
    <section aria-labelledby="farms-heading" :aria-busy="busy">
      <h2 id="farms-heading">Suas farms</h2>
      <label for="device-farm">Farm</label>
      <select id="device-farm" v-model="farmId" @change="loadDevices()">
        <option value="">Selecione</option>
        <option v-for="farm in farms" :key="farm.farmId" :value="farm.farmId">
          {{ farm.farmId }}
        </option>
      </select>
      <button :disabled="busy" @click="loadFarms()">Atualizar farms</button>
      <button v-if="nextFarm" :disabled="busy" @click="loadFarms(nextFarm)">
        Próxima página de farms
      </button>
      <button v-if="farmId" :disabled="busy" @click="loadDevices()">
        Atualizar dispositivos
      </button>
      <p v-if="!busy && !farms.length && !error">Nenhuma farm disponível.</p>
    </section>
    <section v-if="page" aria-labelledby="keys-heading" :aria-busy="busy">
      <h2 id="keys-heading">Chaves deste navegador</h2>
      <p>
        Conta atual: {{ page.currentAccountId }}. Criar outra chave não
        substitui nem revoga as anteriores.
      </p>
      <button :disabled="busy || keys.length >= 32" @click="enroll()">
        Criar chave e solicitar cadastro
      </button>
      <p v-if="!keys.length">
        Nenhuma chave local para esta conta e farm. Se você perdeu o
        armazenamento, crie uma nova chave e solicite nova aprovação.
      </p>
      <ul>
        <li v-for="key in keys" :key="key.thumbprint">
          <p>
            Impressão digital: <code>{{ key.thumbprint }}</code>
          </p>
          <p v-if="!localRegistration(key)">
            O registro desta chave não aparece nesta página. Consulte outras
            páginas ou escolha explicitamente a operação adequada. O servidor
            verifica o estado atual.
          </p>
          <button
            v-if="
              !localRegistration(key) ||
              localRegistration(key)?.proofAt === null
            "
            :disabled="busy || localRegistration(key)?.status === 'revoked'"
            @click="enroll(key, 'enroll')"
          >
            Retomar cadastro com esta chave
          </button>
          <button
            v-if="
              !localRegistration(key) ||
              localRegistration(key)?.proofAt !== null
            "
            :disabled="busy || localRegistration(key)?.status === 'revoked'"
            @click="enroll(key, 'recover')"
          >
            Confirmar posse da chave existente
          </button>
        </li>
      </ul>
      <h2>Registros da farm</h2>
      <p v-if="!page.devices.length">Nenhum dispositivo nesta página.</p>
      <p v-if="admin">
        Para aprovar ou revogar, confira a impressão digital com o titular e
        digite o valor completo.
      </p>
      <label v-if="admin" for="fingerprint-confirmation"
        >Impressão digital confirmada</label
      >
      <input
        v-if="admin"
        id="fingerprint-confirmation"
        v-model="confirmation"
        autocomplete="off"
        :disabled="busy"
      />
      <ul>
        <li v-for="device in page.devices" :key="device.keyId">
          <dl>
            <dt>Conta titular</dt>
            <dd>{{ device.accountId }}</dd>
            <dt>Impressão digital</dt>
            <dd>
              <code>{{ device.thumbprint }}</code>
            </dd>
            <dt>Estado</dt>
            <dd>{{ statusLabel[device.status] }}</dd>
            <dt>Criado em</dt>
            <dd>{{ date(device.createdAt) }}</dd>
            <template v-if="device.pendingExpiresAt"
              ><dt>Prazo do pedido</dt>
              <dd>{{ date(device.pendingExpiresAt) }}</dd></template
            >
          </dl>
          <template v-if="admin"
            ><button
              v-if="device.status === 'pending'"
              :disabled="
                busy ||
                device.proofAt === null ||
                confirmation !== device.thumbprint
              "
              @click="decide(device, 'approve')"
            >
              Aprovar dispositivo</button
            ><button
              v-if="device.status !== 'revoked'"
              :disabled="busy || confirmation !== device.thumbprint"
              @click="decide(device, 'revoke')"
            >
              Revogar definitivamente
            </button></template
          >
        </li>
      </ul>
      <button
        v-if="page.nextAfter"
        :disabled="busy"
        @click="loadDevices(page.nextAfter)"
      >
        Próxima página de dispositivos
      </button>
    </section>
    <section aria-labelledby="recovery-heading">
      <h2 id="recovery-heading">Posse, perda e recuperação</h2>
      <p>
        Cada prova deve terminar em 60 segundos. Um pedido pendente dura 24
        horas desde a criação. Confirmar novamente a posse não renova esse
        prazo. Cada chave admite somente três desafios durante toda sua
        existência, incluindo falhas, expiração e recuperações bem-sucedidas.
        Não há renovação automática desse limite.
      </p>
      <p>
        Em um novo login, a mesma chave pode confirmar sua posse novamente,
        respeitando esses limites e a autorização atual. Uma chave revogada não
        pode ser recuperada. A aprovação exige proprietário ou administrador
        atual e acesso válido do titular.
      </p>
      <p>
        A chave privada não pode ser exportada e permanece no IndexedDB deste
        navegador. Limpar dados, trocar de navegador ou perder este
        armazenamento pode perder a chave. Não há cópia de segurança nem
        substituição automática. Chaves antigas continuam registradas até
        revogação explícita por proprietário ou administrador.
      </p>
      <p>
        Este cadastro não emite sessão de transporte e não oferece comandos,
        sinalização ou conexão com Connector.
      </p>
    </section>
  </main>
</template>

<style scoped>
button,
select,
input {
  font: inherit;
  min-height: 2.75rem;
  margin: 0.5rem;
  max-width: 100%;
}
dd,
code {
  overflow-wrap: anywhere;
}
li {
  margin-block: 1.5rem;
}
:focus-visible {
  outline: 3px solid currentColor;
  outline-offset: 3px;
}
</style>
