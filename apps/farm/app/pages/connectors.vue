<script setup lang="ts">
import '../assets/css/ops-screen.css'
import { useFarmRoute } from '../composables/useFarmRoute.ts'
import { fetchFarmSelectionPage } from '../composables/useFarmMemberships.ts'
import { resolveFarmScope } from '../utils/farm-scope.ts'
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
import StatusBadge from '../components/ui/StatusBadge.vue'
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
const { route, setFarmScope } = useFarmRoute()
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
const statusTone = {
  pending: 'paused',
  approved: 'idle',
  revoked: 'error',
} as const
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
      const page = await fetchFarmSelectionPage(
        route.query.farm,
        options,
        after ?? undefined,
      )
      const capability = await $fetch<{ enabled: boolean }>(
        '/api/connector-pairing/capability',
        { signal: controller.signal, retry: 0, timeout: 10000 },
      ).catch(() => ({ enabled: false }))
      if (current !== generation) return
      pairingEnabled.value = capability.enabled
      farms.value = page.farms
      nextFarm.value = page.nextAfter ?? null
      const selected = resolveFarmScope(
        page.farms,
        route.query.farm,
        !!after || !!page.nextAfter,
      )
      if (selected) {
        farmId.value = selected.farmId
        await load('connectors')
      }
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
    if (kind === 'farms') {
      farms.value = []
      farmId.value = ''
      nextFarm.value = null
    }
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
function switchFarm() {
  void setFarmScope(farmId.value)
  selectFarm()
}
watch(
  () => route.query.farm,
  (requested) => {
    const selected =
      resolveFarmScope(farms.value, requested, !!nextFarm.value)?.farmId ?? ''
    if (farmId.value === selected) return
    farmId.value = selected
    selectFarm()
  },
)
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
  <main id="conteudo" class="connectors-page ops-screen">
    <header class="page-header">
      <p class="eyebrow">Open3DFarmManager</p>
      <h1 ref="heading" tabindex="-1">Connectors da farm</h1>
      <nav aria-label="Conta">
        <ul class="nav-links chips">
          <li><NuxtLink to="/">Início</NuxtLink></li>
          <li><NuxtLink to="/parear">Aprovar Connector</NuxtLink></li>
          <li><NuxtLink to="/sair">Sair da conta</NuxtLink></li>
        </ul>
      </nav>
      <p class="intro">
        Consulte os registros de pareamento das farms às quais sua conta tem
        acesso. Este inventário não indica se o Connector está conectado agora.
      </p>
    </header>
    <div ref="errorSummary" class="alert" role="alert" tabindex="-1">
      <ErrorState
        v-if="error"
        title="Inventário indisponível"
        :description="error"
      >
        <div class="actions">
          <Button @click="load('farms')">Tentar novamente</Button>
          <NuxtLink to="/entrar">Entrar na conta</NuxtLink>
        </div>
      </ErrorState>
    </div>
    <section class="panel" aria-labelledby="farms-heading" :aria-busy="pending">
      <h2 id="farms-heading">Suas farms</h2>
      <div class="field">
        <label for="farm">Selecione uma farm</label>
        <select
          id="farm"
          v-model="farmId"
          :disabled="pending || !farms.length"
          @change="switchFarm"
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
      </div>
      <p class="hint">
        O identificador distingue suas farms; não é necessário copiá-lo ou
        digitá-lo.
      </p>
      <div class="actions">
        <Button :disabled="pending" @click="load('farms')">
          Atualizar farms
        </Button>
        <Button
          v-if="nextFarm"
          :disabled="pending"
          @click="load('farms', nextFarm)"
        >
          Próxima página de farms
        </Button>
      </div>
    </section>
    <div v-if="pending" aria-busy="true" class="loading panel">
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
    <section
      v-if="farmId && !pending"
      class="panel inventory"
      aria-labelledby="inventory-heading"
    >
      <h2 id="inventory-heading">Connectors registrados</h2>
      <p class="hint">
        Versões são consultadas pela conexão direta autenticada. Sem uma chave
        aprovada neste navegador ou sem conexão, a versão permanece
        desconhecida.
      </p>
      <div v-if="versionReady?.keys.kind === 'available'" class="field">
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
      </div>
      <div
        v-if="
          versionReady?.nextPrinter && versionReady.scope?.farmId === farmId
        "
        class="actions"
      >
        <Button
          @click="versionFeed.selectFarm(farmId, versionReady.nextPrinter)"
        >
          Consultar versões das próximas impressoras
        </Button>
      </div>
      <EmptyState
        v-if="!connectors.length"
        title="Nenhum Connector registrado"
        description="Esta farm ainda não tem registros de pareamento. Inicie o pareamento no Connector e aprove-o para que ele apareça aqui."
        :level="3"
      >
        <NuxtLink to="/parear">Aprovar um novo Connector</NuxtLink>
      </EmptyState>
      <ul v-else class="connector-list">
        <li v-for="connector in connectors" :key="connector.agentId">
          <dl class="facts">
            <dt>Connector</dt>
            <dd class="ops-data">{{ connector.agentId }}</dd>
            <dt>Impressão digital</dt>
            <dd class="ops-data">{{ connector.fingerprint }}</dd>
            <dt>Versão do Connector</dt>
            <dd class="ops-data">
              {{ versionFor(connector.agentId).version }}
            </dd>
            <dt>Revisão do protocolo</dt>
            <dd class="ops-data">
              {{ versionFor(connector.agentId).revision }}
            </dd>
            <dt>Estado do registro</dt>
            <dd>
              <StatusBadge
                :tone="statusTone[connector.status]"
                :label="statusLabel[connector.status]"
              />
            </dd>
          </dl>
          <p
            v-if="
              connectorRtcScopeHint(
                versionFeed.versions.value.get(connector.agentId)?.rtcScope,
              )
            "
            class="hint"
          >
            {{
              connectorRtcScopeHint(
                versionFeed.versions.value.get(connector.agentId)?.rtcScope,
              )
            }}
          </p>
          <p
            v-if="versionFor(connector.agentId).warning"
            class="hint warning"
            role="status"
          >
            {{ versionFor(connector.agentId).warning }}
            <a :href="connectorUpgradeDoc">Documentação de atualização</a>
          </p>
          <div
            v-if="pairingEnabled && connector.status !== 'revoked'"
            class="actions"
          >
            <Button
              class="danger"
              :disabled="pending"
              @click="selectRecovery(connector)"
            >
              Revogar este Connector
            </Button>
          </div>
        </li>
      </ul>
      <div v-if="nextConnector" class="actions">
        <Button :disabled="pending" @click="load('connectors', nextConnector)">
          Próxima página de Connectors
        </Button>
      </div>
    </section>
    <section class="panel" aria-labelledby="recovery-heading">
      <h2 id="recovery-heading">Recuperação e revogação</h2>
      <p>
        Se a confirmação do pareamento foi perdida, selecione o registro exato
        no inventário, confira a impressão digital e revogue-o. Depois, inicie
        um novo pareamento no Connector. Uma credencial anterior não será
        reenviada.
      </p>
      <p class="notice" role="status">{{ recoveryMessage }}</p>
      <div v-if="recoveryTarget" class="target">
        <dl class="facts">
          <dt>Farm</dt>
          <dd class="ops-data">{{ farmId }}</dd>
          <dt>Connector</dt>
          <dd class="ops-data">{{ recoveryTarget.agentId }}</dd>
          <dt>Impressão digital</dt>
          <dd class="ops-data">{{ recoveryTarget.fingerprint }}</dd>
        </dl>
        <label class="check"
          ><input
            v-model="recoveryConfirmed"
            type="checkbox"
            :disabled="pending"
          />
          Conferi este Connector e quero revogar seu registro.</label
        >
        <div class="actions">
          <Button
            class="danger"
            :disabled="pending || !recoveryConfirmed"
            @click="revoke"
          >
            Confirmar revogação
          </Button>
          <Button :disabled="pending" @click="selectRecovery(null)">
            Cancelar revogação
          </Button>
        </div>
      </div>
      <template v-if="!pairingEnabled">
        <div class="actions">
          <Button disabled aria-describedby="recovery-help">
            Revogar Connector
          </Button>
        </div>
        <p id="recovery-help" class="hint">
          A revogação está indisponível nesta sessão.
        </p>
      </template>
      <p class="hint">
        Sem conexão direta com o Connector, o modo degradado é somente leitura.
        Comandos e câmeras não estão disponíveis por esta consulta HTTP.
      </p>
    </section>
  </main>
</template>

<style scoped>
.page-header h1 {
  justify-self: start;
  max-width: 100%;
}
.page-header h1:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
  border-radius: var(--ops-radius-sm);
}
.nav-links {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ops-space-2);
  margin: var(--ops-space-1) 0 0;
  padding: 0;
  list-style: none;
}
.alert:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
  border-radius: var(--ops-radius-lg);
}
.alert:empty {
  display: none;
}
.panel > * {
  margin-block: 0;
}
.field {
  display: grid;
  gap: var(--ops-space-1);
  min-width: 0;
  max-width: 38rem;
}
select {
  width: 100%;
}
.hint {
  font-size: var(--ops-text-small);
  color: var(--ops-muted);
}
.warning {
  color: var(--ops-attention);
}
.notice {
  padding: var(--ops-space-2) var(--ops-space-3);
  border: 1px solid var(--ops-border);
  border-inline-start: 3px solid var(--ops-action);
  border-radius: var(--ops-radius-sm);
}
.notice:empty {
  display: none;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ops-space-2) var(--ops-space-3);
  align-items: center;
}
.connector-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 30rem), 1fr));
  gap: var(--ops-space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}
.connector-list > li {
  display: grid;
  align-content: start;
  gap: var(--ops-space-3);
  padding: var(--ops-space-3);
  border: 1px solid var(--ops-border);
  border-radius: var(--ops-radius-md);
  min-width: 0;
}
.facts {
  display: grid;
  grid-template-columns: minmax(8rem, max-content) minmax(0, 1fr);
  gap: var(--ops-space-2) var(--ops-space-4);
  align-items: baseline;
  margin: 0;
}
.facts dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.target {
  display: grid;
  gap: var(--ops-space-3);
  padding: var(--ops-space-3);
  border: 1px solid var(--ops-fault);
  border-radius: var(--ops-radius-md);
}
.connectors-page .check {
  display: flex;
  align-items: center;
  gap: var(--ops-space-2);
  min-height: 2.75rem;
  font-size: var(--ops-text-body);
  font-weight: 400;
}
.check input {
  flex: 0 0 auto;
  width: 1.25rem;
  height: 1.25rem;
}
@media (max-width: 30rem) {
  .facts {
    grid-template-columns: minmax(0, 1fr);
    gap: 0;
  }
  .facts dd {
    margin-bottom: var(--ops-space-2);
  }
}
</style>
