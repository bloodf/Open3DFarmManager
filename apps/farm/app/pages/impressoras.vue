<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
type Printer = {
  assignmentId: string
  agentId: string
  printerKey: string
  status: 'active' | 'revoked'
  connectorStatus: 'pending' | 'approved' | 'revoked'
}
const farms = ref<{ farmId: string }[]>([]),
  farmId = ref(''),
  printers = ref<Printer[]>([]),
  connectors = ref<{ agentId: string; fingerprint: string; status: string }[]>(
    [],
  )
const nextFarm = ref<string | null>(null),
  nextPrinter = ref<string | null>(null),
  nextConnector = ref<string | null>(null)
const canManage = ref(false),
  pending = ref(false),
  error = ref(''),
  message = ref(''),
  agentId = ref(''),
  printerKey = ref(''),
  confirmed = ref(false),
  revokeTarget = ref<Printer | null>(null),
  revokeConfirmed = ref(false)
const heading = ref<HTMLElement | null>(null),
  errorSummary = ref<HTMLElement | null>(null)
let generation = 0,
  controller: AbortController | undefined
function clear() {
  generation++
  controller?.abort()
  controller = undefined
  printers.value = []
  connectors.value = []
  canManage.value = false
  nextPrinter.value = null
  nextConnector.value = null
  agentId.value = ''
  printerKey.value = ''
  confirmed.value = false
  revokeTarget.value = null
  revokeConfirmed.value = false
}
async function run(
  work: (signal: AbortSignal, current: number) => Promise<void>,
) {
  if (pending.value) return
  pending.value = true
  error.value = ''
  const current = generation
  controller = new AbortController()
  try {
    await work(controller.signal, current)
  } catch {
    if (current === generation) {
      clear()
      farms.value = []
      farmId.value = ''
      nextFarm.value = null
      error.value =
        'Não foi possível confirmar os dados. Entre novamente e atualize a página antes de continuar.'
      await nextTick()
      errorSummary.value?.focus()
    }
  } finally {
    if (current === generation || error.value) pending.value = false
  }
}
function options(signal: AbortSignal) {
  return { signal, retry: 0, timeout: 10000 }
}
async function loadFarms(after: string | null = null) {
  if (pending.value) return
  clear()
  farmId.value = ''
  message.value = ''
  await run(async (signal, current) => {
    const page = await $fetch<{
      farms: { farmId: string }[]
      nextAfter: string | null
    }>('/api/farms', { ...options(signal), query: after ? { after } : {} })
    if (current !== generation) return
    farms.value = page.farms
    nextFarm.value = page.nextAfter
  })
}
async function loadAssignments(
  signal: AbortSignal,
  current: number,
  after: string | null = null,
) {
  const page = await $fetch<{
    printers: Printer[]
    nextAfter: string | null
    canManage: boolean
  }>(`/api/farms/${farmId.value}/printers`, {
    ...options(signal),
    query: after ? { after } : {},
  })
  if (current !== generation) return
  revokeTarget.value = null
  revokeConfirmed.value = false
  printers.value = page.printers
  nextPrinter.value = page.nextAfter
  canManage.value = page.canManage
}
async function loadConnectors(
  signal: AbortSignal,
  current: number,
  after: string | null = null,
) {
  const page = await $fetch<{
    connectors: { agentId: string; fingerprint: string; status: string }[]
    nextAfter: string | null
  }>(`/api/farms/${farmId.value}/connectors`, {
    ...options(signal),
    query: after ? { after } : {},
  })
  if (current !== generation) return
  agentId.value = ''
  confirmed.value = false
  connectors.value = page.connectors.filter((c) => c.status === 'approved')
  nextConnector.value = page.nextAfter
}
async function selectFarm() {
  clear()
  message.value = ''
  if (!farmId.value) return
  await run(async (signal, current) => {
    await loadAssignments(signal, current)
    if (current === generation && canManage.value)
      await loadConnectors(signal, current)
  })
}
function cancelRevocation() {
  revokeTarget.value = null
  revokeConfirmed.value = false
}
function selectRevocation(printer: Printer) {
  revokeTarget.value = printer
  revokeConfirmed.value = false
}
async function register() {
  if (
    !confirmed.value ||
    !agentId.value ||
    !printerKey.value ||
    !canManage.value
  )
    return
  await run(async (signal, current) => {
    await $fetch(`/api/farms/${farmId.value}/printers`, {
      ...options(signal),
      method: 'POST',
      body: {
        agentId: agentId.value,
        printerKey: printerKey.value,
        confirmedLocalConfiguration: true,
      },
    })
    if (current !== generation) return
    printerKey.value = ''
    confirmed.value = false
    message.value =
      'Atribuição registrada. Isso não confirma conexão com a impressora nem autoriza comandos.'
    await loadAssignments(signal, current)
  })
}
async function revoke() {
  const target = revokeTarget.value
  if (!target || !revokeConfirmed.value || !canManage.value) return
  await run(async (signal, current) => {
    await $fetch(
      `/api/farms/${farmId.value}/printers/${target.assignmentId}/revoke`,
      {
        ...options(signal),
        method: 'POST',
        body: { agentId: target.agentId, printerKey: target.printerKey },
      },
    )
    if (current !== generation) return
    revokeTarget.value = null
    revokeConfirmed.value = false
    message.value =
      'Atribuição revogada permanentemente. Uma reatribuição exige um novo cadastro.'
    await loadAssignments(signal, current)
  })
}
onMounted(() => {
  heading.value?.focus()
  void loadFarms()
})
onBeforeUnmount(clear)
onBeforeRouteLeave(clear)
</script>
<template>
  <main>
    <h1 ref="heading" tabindex="-1">Impressoras da farm</h1>
    <nav aria-label="Conta">
      <NuxtLink to="/">Início</NuxtLink> ·
      <NuxtLink to="/connectors">Connectors</NuxtLink> ·
      <NuxtLink to="/sair">Sair da conta</NuxtLink>
    </nav>
    <p>
      Consulte as atribuições de impressoras. Sem conexão direta com o
      Connector, o modo degradado é somente leitura para operação: esta página
      não envia comandos nem acessa câmeras.
    </p>
    <p v-if="error" ref="errorSummary" role="alert" tabindex="-1">
      {{ error }} <NuxtLink to="/entrar">Entrar novamente</NuxtLink>
    </p>
    <p role="status" aria-live="polite">{{ pending ? 'Aguarde.' : message }}</p>
    <label for="printer-farm">Farm</label
    ><select
      id="printer-farm"
      v-model="farmId"
      :disabled="pending"
      @change="selectFarm"
    >
      <option value="">Selecione uma farm</option>
      <option v-for="farm in farms" :key="farm.farmId" :value="farm.farmId">
        {{ farm.farmId }}
      </option>
    </select>
    <button
      v-if="nextFarm"
      type="button"
      :disabled="pending"
      @click="loadFarms(nextFarm)"
    >
      Próximas farms
    </button>
    <section v-if="farmId" aria-labelledby="assignment-heading">
      <h2 id="assignment-heading">Atribuições</h2>
      <p v-if="!pending && !printers.length">
        Nenhuma atribuição nesta página.
      </p>
      <ul>
        <li v-for="printer in printers" :key="printer.assignmentId">
          <dl>
            <dt>Chave exata</dt>
            <dd class="exact-key">{{ printer.printerKey }}</dd>
            <dt>Connector</dt>
            <dd>{{ printer.agentId }}</dd>
            <dt>Estado da atribuição</dt>
            <dd>
              {{
                printer.status === 'revoked'
                  ? 'Revogada permanentemente'
                  : 'Ativa'
              }}
            </dd>
            <dt>Autorização atual do Connector</dt>
            <dd>
              {{
                printer.connectorStatus === 'approved'
                  ? 'Aprovado'
                  : printer.connectorStatus === 'revoked'
                    ? 'Revogado, uso indisponível'
                    : 'Pendente, uso indisponível'
              }}
            </dd>
          </dl>
          <button
            v-if="canManage && printer.status === 'active'"
            type="button"
            :disabled="pending"
            @click="selectRevocation(printer)"
          >
            Revogar atribuição de {{ printer.printerKey }}
          </button>
        </li>
      </ul>
      <button
        v-if="nextPrinter"
        type="button"
        :disabled="pending"
        @click="
          run((signal, current) =>
            loadAssignments(signal, current, nextPrinter),
          )
        "
      >
        Próximas atribuições
      </button>
      <p v-if="!canManage">
        Somente proprietários e administradores podem cadastrar ou revogar
        atribuições.
      </p>
    </section>
    <section v-if="farmId && canManage" aria-labelledby="register-heading">
      <h2 id="register-heading">Cadastrar atribuição</h2>
      <p id="configuration-help">
        Confira a configuração local do Connector e copie a chave exata. Sua
        confirmação é uma declaração administrativa. O servidor não descobre
        impressoras nem verifica a configuração local. Não informe endereço de
        rede ou G-code.
      </p>
      <form @submit.prevent="register">
        <fieldset :disabled="pending">
          <legend>Configuração confirmada localmente</legend>
          <label for="printer-agent">Connector aprovado</label
          ><select id="printer-agent" v-model="agentId" required>
            <option value="">Selecione um Connector aprovado</option>
            <option
              v-for="connector in connectors"
              :key="connector.agentId"
              :value="connector.agentId"
            >
              {{ connector.agentId }} · {{ connector.fingerprint }}
            </option></select
          ><button
            v-if="nextConnector"
            type="button"
            @click="
              run((signal, current) =>
                loadConnectors(signal, current, nextConnector),
              )
            "
          >
            Próximos Connectors
          </button>
          <p v-if="!connectors.length">
            Nenhum Connector aprovado nesta página.
          </p>
          <label for="printer-key">Chave exata da impressora</label
          ><input
            id="printer-key"
            v-model="printerKey"
            required
            maxlength="128"
            autocomplete="off"
            aria-describedby="configuration-help key-help"
          />
          <p id="key-help">
            De 1 a 128 unidades UTF-16, sem alterar espaços, maiúsculas ou
            acentos.
          </p>
          <label
            ><input v-model="confirmed" type="checkbox" required /> Conferi que
            esta chave exata está configurada localmente neste Connector.</label
          ><button
            type="submit"
            :disabled="!confirmed || !agentId || !printerKey"
          >
            Cadastrar atribuição
          </button>
        </fieldset>
      </form>
      <p>
        Revogar é permanente. Para reatribuir uma chave, revogue a atribuição
        atual e cadastre uma nova. O novo cadastro pode falhar; nenhuma
        atribuição anterior será restaurada.
      </p>
    </section>
    <section v-if="revokeTarget" aria-labelledby="revoke-heading">
      <h2 id="revoke-heading">Confirmar revogação permanente</h2>
      <p>
        Chave: <span class="exact-key">{{ revokeTarget.printerKey }}</span
        >. Connector: {{ revokeTarget.agentId }}.
      </p>
      <label
        ><input v-model="revokeConfirmed" type="checkbox" :disabled="pending" />
        Conferi esta atribuição e quero revogá-la permanentemente.</label
      ><button
        type="button"
        :disabled="pending || !revokeConfirmed"
        @click="revoke"
      >
        Confirmar revogação</button
      ><button type="button" :disabled="pending" @click="cancelRevocation">
        Cancelar revogação
      </button>
    </section>
  </main>
</template>
<style scoped>
main {
  max-width: 58rem;
  margin: 2rem auto;
  padding: 0 1rem;
  line-height: 1.6;
}
section {
  margin-block: 2rem;
}
label,
select,
input:not([type='checkbox']),
button {
  display: block;
  margin-block: 0.6rem;
}
input,
select,
button {
  font: inherit;
  max-width: 100%;
}
button {
  padding: 0.5rem 0.75rem;
}
dd {
  overflow-wrap: anywhere;
}
.exact-key {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
fieldset {
  padding: 1rem;
}
:focus-visible {
  outline: 3px solid #155e75;
  outline-offset: 3px;
}
</style>
