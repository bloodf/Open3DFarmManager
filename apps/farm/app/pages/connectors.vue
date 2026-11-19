<script setup lang="ts">
import {
  connectorRtcScopeHint,
  connectorVersionView,
  connectorUpgradeDoc,
} from '../utils/connector-version.ts'
import { useConnectorVersions } from '../utils/connector-version-feed.ts'
import Button from '../components/ui/Button.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import ErrorState from '../components/ui/ErrorState.vue'
import Skeleton from '../components/ui/Skeleton.vue'
const versionFeed = useConnectorVersions()
const versionReady = versionFeed.ready

function versionFor(agentId: string) {
  return connectorVersionView(
    versionReady.value?.scope?.farmId === farmId.value
      ? versionFeed.versions.value.get(agentId)
      : undefined,
  )
}
type Farm = { farmId: string }
type Connector = {
  agentId: string
  fingerprint: string
  status: 'pending' | 'approved' | 'revoked'
}
const farms = ref<Farm[]>([])
const connectors = ref<Connector[]>([])
const farmId = ref('')
watch([farmId, versionReady], ([selected, ready]) => {
  if (
    selected &&
    ready &&
    ready.scope?.farmId !== selected &&
    ready.farms.some((farm) => farm.farmId === selected)
  )
    void versionFeed.selectFarm(selected)
})
const nextFarm = ref<string | null>(null)
const nextConnector = ref<string | null>(null)
const pending = ref(false)
const error = ref('')
const pairingEnabled = ref(false)
const recoveryTarget = ref<Connector | null>(null)
const recoveryConfirmed = ref(false)
const recoveryMessage = ref('')
const heading = ref<HTMLElement | null>(null)
const errorSummary = ref<HTMLElement | null>(null)
let generation = 0
let controller: AbortController | undefined
const statusLabel = {
  pending: 'Pendente',
  approved: 'Aprovado',
  revoked: 'Revogado',
}

function cancel() {
  generation++
  controller?.abort()
  controller = undefined
  connectors.value = []
  recoveryTarget.value = null
  recoveryConfirmed.value = false
  nextConnector.value = null
}
async function load(kind: 'farms' | 'connectors', after: string | null = null) {
  cancel()
  const current = generation
  controller = new AbortController()
  pending.value = true
  error.value = ''
  try {
    const options = {
      query: { limit: 20, ...(after ? { after } : {}) },
      signal: controller.signal,
      retry: 0,
      timeout: 15000,
    }
    if (kind === 'farms') {
      farms.value = []
      farmId.value = ''
      nextFarm.value = null
      const page = await $fetch<{ farms: Farm[]; nextAfter: string | null }>(
        '/api/farms',
        options,
      )
      const capability = await $fetch<{ enabled: boolean }>(
        '/api/connector-pairing/capability',
        { signal: controller.signal, retry: 0, timeout: 10000 },
      ).catch(() => ({ enabled: false }))
      if (current !== generation) return
      pairingEnabled.value = capability.enabled
      farms.value = page.farms
      nextFarm.value = page.nextAfter
    } else {
      const selected = farmId.value
      const page = await $fetch<{
        connectors: Connector[]
        nextAfter: string | null
      }>(`/api/farms/${selected}/connectors`, options)
      if (current !== generation || selected !== farmId.value) return
      connectors.value = page.connectors
      nextConnector.value = page.nextAfter
    }
  } catch (cause) {
    if (current !== generation) return
    // Clear all account data on any failed request; never retain a stale authorized view.
    farms.value = []
    farmId.value = ''
    nextFarm.value = null
    const status =
      cause && typeof cause === 'object' && 'statusCode' in cause
        ? cause.statusCode
        : undefined
    error.value =
      status === 401
        ? 'Sua sessão não está disponível. Entre novamente para consultar suas farms.'
        : 'Não foi possível consultar o inventário. Tente novamente.'
    await nextTick()
    errorSummary.value?.focus()
  } finally {
    if (current === generation) pending.value = false
  }
}
function selectRecovery(target: Connector | null) {
  recoveryTarget.value = target
  recoveryConfirmed.value = false
}
function selectFarm() {
  versionFeed.versions.value = new Map()
  if (farmId.value) void versionFeed.selectFarm(farmId.value)
  cancel()
  if (farmId.value) void load('connectors')
}
async function revoke() {
  const target = recoveryTarget.value
  const selected = farmId.value
  if (
    !pairingEnabled.value ||
    !target ||
    !recoveryConfirmed.value ||
    pending.value
  )
    return
  const current = generation
  controller = new AbortController()
  pending.value = true
  recoveryMessage.value = ''
  try {
    await $fetch(`/api/farms/${selected}/connectors/${target.agentId}/revoke`, {
      method: 'POST',
      body: { expected_fingerprint: target.fingerprint },
      signal: controller.signal,
      retry: 0,
      timeout: 10000,
    })
    if (current !== generation || selected !== farmId.value) return
    recoveryMessage.value =
      'Registro revogado. Inicie um novo pareamento no Connector e confira a nova aprovação.'
    await load('connectors')
  } catch {
    if (current !== generation) return
    cancel()
    farms.value = []
    farmId.value = ''
    nextFarm.value = null
    pairingEnabled.value = false
    recoveryMessage.value =
      'Não foi possível confirmar a revogação. Entre novamente e atualize o inventário antes de continuar.'
  } finally {
    pending.value = false
  }
}
onMounted(() => {
  heading.value?.focus()
  void load('farms')
})
onBeforeUnmount(() => {
  cancel()
  farms.value = []
  farmId.value = ''
})
onBeforeRouteLeave(() => {
  cancel()
  farms.value = []
  farmId.value = ''
})
</script>

<template>
  <main id="conteudo">
    <small>Open3DFarmManager</small>
    <h1 ref="heading" tabindex="-1">Connectors da farm</h1>
    <nav aria-label="Conta">
      <NuxtLink to="/">Início</NuxtLink> ·
      <NuxtLink to="/parear">Aprovar Connector</NuxtLink> ·
      <NuxtLink to="/sair">Sair da conta</NuxtLink>
    </nav>
    <p>
      Consulte os registros de pareamento das farms às quais sua conta tem
      acesso. Este inventário não indica se o Connector está conectado agora.
    </p>
    <div ref="errorSummary" role="alert" tabindex="-1">
      <ErrorState
        v-if="error"
        title="Inventário indisponível"
        :description="error"
      >
        <Button @click="load('farms')">Tentar novamente</Button>
        <NuxtLink to="/entrar">Entrar na conta</NuxtLink>
      </ErrorState>
    </div>
    <section aria-labelledby="farms-heading" :aria-busy="pending">
      <h2 id="farms-heading">Suas farms</h2>
      <label for="farm">Selecione uma farm</label>
      <select
        id="farm"
        v-model="farmId"
        :disabled="pending || !farms.length"
        @change="selectFarm"
      >
        <option value="">Selecione</option>
        <option
          v-for="(farm, index) in farms"
          :key="farm.farmId"
          :value="farm.farmId"
        >
          Farm {{ index + 1 }} · {{ farm.farmId }}
        </option>
      </select>
      <p>
        O identificador distingue suas farms; não é necessário copiá-lo ou
        digitá-lo.
      </p>
      <button type="button" :disabled="pending" @click="load('farms')">
        Atualizar farms
      </button>
      <button
        v-if="nextFarm"
        type="button"
        :disabled="pending"
        @click="load('farms', nextFarm)"
      >
        Próxima página de farms
      </button>
      <div v-if="pending" aria-busy="true">
        <p role="status">Carregando o inventário…</p>
        <Skeleton /><Skeleton /><Skeleton />
      </div>
      <EmptyState
        v-else-if="!error && !farms.length"
        title="Nenhuma farm disponível"
        description="Sua conta ainda não tem acesso a uma farm. Peça um convite a uma proprietária ou a um proprietário e consulte de novo."
      >
        <Button @click="load('farms')">Consultar novamente</Button>
      </EmptyState>
      <template v-if="farmId && !pending">
        <h2>Connectors registrados</h2>
        <p>
          Versões são consultadas pela conexão direta autenticada. Sem uma chave
          aprovada neste navegador ou sem conexão, a versão permanece
          desconhecida.
        </p>
        <template v-if="versionReady?.keys.kind === 'available'">
          <label for="version-key"
            >Chave do navegador para consultar versões</label
          >
          <select
            id="version-key"
            :value="versionReady.keys.selected"
            @change="
              versionFeed.selectKey(($event.target as HTMLSelectElement).value)
            "
          >
            <option value="">Selecione uma chave</option>
            <option
              v-for="key in versionReady.keys.choices"
              :key="key.keyId"
              :value="key.keyId"
            >
              {{ key.thumbprint }}
            </option>
          </select>
        </template>
        <button
          v-if="
            versionReady?.nextPrinter && versionReady.scope?.farmId === farmId
          "
          type="button"
          @click="versionFeed.selectFarm(farmId, versionReady.nextPrinter)"
        >
          Consultar versões das próximas impressoras
        </button>
        <EmptyState
          v-if="!connectors.length"
          title="Nenhum Connector registrado"
          description="Esta farm ainda não tem registros de pareamento. Inicie o pareamento no Connector e aprove-o para que ele apareça aqui."
        >
          <NuxtLink to="/parear">Aprovar um novo Connector</NuxtLink>
        </EmptyState>
        <ul v-else>
          <li v-for="connector in connectors" :key="connector.agentId">
            <dl>
              <dt>Connector</dt>
              <dd>{{ connector.agentId }}</dd>
              <dt>Impressão digital</dt>
              <dd>{{ connector.fingerprint }}</dd>
              <dt>Versão do Connector</dt>
              <dd>{{ versionFor(connector.agentId).version }}</dd>
              <dt>Revisão do protocolo</dt>
              <dd>{{ versionFor(connector.agentId).revision }}</dd>
              <dt>Estado do registro</dt>
              <dd>{{ statusLabel[connector.status] }}</dd>
            </dl>
            <p
              v-if="
                connectorRtcScopeHint(
                  versionFeed.versions.value.get(connector.agentId)?.rtcScope,
                )
              "
            >
              {{
                connectorRtcScopeHint(
                  versionFeed.versions.value.get(connector.agentId)?.rtcScope,
                )
              }}
            </p>
            <p v-if="versionFor(connector.agentId).warning" role="status">
              {{ versionFor(connector.agentId).warning }}
              <a :href="connectorUpgradeDoc">Documentação de atualização</a>
            </p>
            <button
              v-if="pairingEnabled && connector.status !== 'revoked'"
              type="button"
              :disabled="pending"
              @click="selectRecovery(connector)"
            >
              Revogar este Connector
            </button>
          </li>
        </ul>
        <button
          v-if="nextConnector"
          type="button"
          :disabled="pending"
          @click="load('connectors', nextConnector)"
        >
          Próxima página de Connectors
        </button>
      </template>
    </section>
    <section aria-labelledby="recovery-heading">
      <h2 id="recovery-heading">Recuperação e revogação</h2>
      <p>
        Se a confirmação do pareamento foi perdida, selecione o registro exato
        no inventário, confira a impressão digital e revogue-o. Depois, inicie
        um novo pareamento no Connector. Uma credencial anterior não será
        reenviada.
      </p>
      <p role="status">{{ recoveryMessage }}</p>
      <template v-if="recoveryTarget">
        <p>Farm: {{ farmId }}</p>
        <p>Connector: {{ recoveryTarget.agentId }}</p>
        <p>Impressão digital: {{ recoveryTarget.fingerprint }}</p>
        <label
          ><input
            v-model="recoveryConfirmed"
            type="checkbox"
            :disabled="pending"
          />
          Conferi este Connector e quero revogar seu registro.</label
        >
        <button
          type="button"
          :disabled="pending || !recoveryConfirmed"
          @click="revoke"
        >
          Confirmar revogação
        </button>
        <button type="button" :disabled="pending" @click="selectRecovery(null)">
          Cancelar revogação
        </button>
      </template>
      <template v-if="!pairingEnabled">
        <button type="button" disabled aria-describedby="recovery-help">
          Revogar Connector
        </button>
        <p id="recovery-help">A revogação está indisponível nesta sessão.</p>
      </template>
      <p>
        Sem conexão direta com o Connector, o modo degradado é somente leitura.
        Comandos e câmeras não estão disponíveis por esta consulta HTTP.
      </p>
    </section>
  </main>
</template>

<style scoped>
select,
button {
  font: inherit;
  min-height: 2.75rem;
  margin: 0.5rem;
  max-width: 100%;
}
dd {
  overflow-wrap: anywhere;
}
:focus-visible {
  outline: 3px solid currentColor;
  outline-offset: 3px;
}
</style>
