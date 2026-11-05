<script setup lang="ts">
type Farm = { farmId: string }
type Connector = {
  agentId: string
  fingerprint: string
  status: 'pending' | 'approved' | 'revoked'
}
const farms = ref<Farm[]>([])
const connectors = ref<Connector[]>([])
const farmId = ref('')
const nextFarm = ref<string | null>(null)
const nextConnector = ref<string | null>(null)
const pending = ref(false)
const error = ref('')
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
      if (current !== generation) return
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
function selectFarm() {
  cancel()
  if (farmId.value) void load('connectors')
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
      <NuxtLink to="/sair">Sair da conta</NuxtLink>
    </nav>
    <p>
      Consulte os registros de pareamento das farms às quais sua conta tem
      acesso. Este inventário não indica se o Connector está conectado agora.
    </p>
    <p ref="errorSummary" role="alert" tabindex="-1">{{ error }}</p>
    <p v-if="error"><NuxtLink to="/entrar">Entrar na conta</NuxtLink></p>
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
      <p role="status">
        {{
          pending
            ? 'Consultando inventário…'
            : !error && !farms.length
              ? 'Nenhuma farm disponível para esta conta.'
              : ''
        }}
      </p>
      <template v-if="farmId && !pending">
        <h2>Connectors registrados</h2>
        <p v-if="!connectors.length">Nenhum Connector registrado nesta farm.</p>
        <ul v-else>
          <li v-for="connector in connectors" :key="connector.agentId">
            <dl>
              <dt>Connector</dt>
              <dd>{{ connector.agentId }}</dd>
              <dt>Impressão digital</dt>
              <dd>{{ connector.fingerprint }}</dd>
              <dt>Estado do registro</dt>
              <dd>{{ statusLabel[connector.status] }}</dd>
            </dl>
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
        A recuperação de credenciais e a revogação ainda não estão disponíveis
        nesta interface. Consultar um registro não altera sua autorização.
      </p>
      <button type="button" disabled aria-describedby="recovery-help">
        Revogar Connector
      </button>
      <p id="recovery-help">
        A ação depende da integração de segurança em desenvolvimento.
      </p>
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
