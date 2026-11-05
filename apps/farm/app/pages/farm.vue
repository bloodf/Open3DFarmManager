<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useFarmView } from '../composables/useFarmView.ts'
import {
  localInterfaceOrigin,
  observationAge,
  printerStateLabel,
  type FarmRow,
} from '../utils/farm-view.ts'

definePageMeta({ middleware: 'farm-flag' })
const { state, ready, now, discover, selectFarm, selectKey, confirmOrigin } =
  useFarmView()
const heading = ref<HTMLElement | null>(null)
const errorSummary = ref<HTMLElement | null>(null)
const drafts = ref<
  Record<string, { value: string; confirmed: boolean; error: string }>
>({})
watch(
  () => ready.value?.scope?.viewEpoch,
  () => {
    drafts.value = {}
  },
)
watch(
  () => state.value.kind,
  async (kind) => {
    if (kind === 'error') {
      await nextTick()
      errorSummary.value?.focus()
    }
  },
)
onMounted(() => heading.value?.focus())
const errorText = computed(() => {
  if (state.value.kind !== 'error') return ''
  switch (state.value.reason) {
    case 'forbidden':
      return 'Esta farm não está disponível para sua conta.'
    case 'rate-limit':
      return 'Aguarde antes de tentar novamente.'
    case 'account-changed':
      return 'A conta mudou. Entre novamente para confirmar seus dados.'
    case 'invalid-response':
      return 'Não foi possível confirmar os dados recebidos. Tente novamente.'
    case 'unavailable':
      return 'Não foi possível confirmar seus dados. Tente novamente.'
  }
})
const keyText = computed(() => {
  const keys = ready.value?.keys
  if (!keys || keys.kind === 'available') return ''
  if (keys.kind === 'loading')
    return 'Consultando os dispositivos deste navegador…'
  switch (keys.reason) {
    case 'storage':
      return 'Não foi possível acessar as chaves salvas neste navegador.'
    case 'registry':
      return 'Não foi possível confirmar a aprovação dos dispositivos.'
    case 'incomplete':
      return 'A consulta dos dispositivos ficou incompleta. Nenhum dispositivo foi selecionado.'
    case 'pending':
      return 'O dispositivo deste navegador aguarda aprovação.'
    case 'revoked':
      return 'O dispositivo deste navegador foi revogado.'
    case 'missing':
      return 'Nenhuma chave local corresponde a um dispositivo aprovado desta conta e farm.'
  }
})
const renderedRows = computed(
  () =>
    ready.value?.rows.map((row) => ({
      ...row,
      draft: drafts.value[row.assignment.assignmentId],
    })) ?? [],
)
const connectionNotice = computed(() => {
  const rows = ready.value?.rows ?? []
  if (rows.some((row) => row.connection === 'authenticated'))
    return 'Conexão direta autenticada. Os controles continuam em modo somente leitura.'
  if (rows.some((row) => row.connection === 'verifying'))
    return 'Verificando conexão direta…'
  if (rows.some((row) => row.connection === 'connecting'))
    return 'Estabelecendo conexão direta…'
  return 'Conexão direta indisponível. A conexão direta com o Connector ainda não está disponível.'
})
function chooseFarm(event: Event) {
  if (event.target instanceof HTMLSelectElement)
    void selectFarm(event.target.value)
}
function chooseKey(event: Event) {
  if (event.target instanceof HTMLSelectElement) selectKey(event.target.value)
}
function setupLink(id: string) {
  drafts.value[id] = { value: '', confirmed: false, error: '' }
}
function saveLink(id: string) {
  const draft = drafts.value[id]
  if (!draft) return
  if (!confirmOrigin(id, draft.value, draft.confirmed)) {
    draft.error =
      'Informe somente a origem HTTP ou HTTPS, sem caminho, credenciais, espaços ou parâmetros, e confirme o endereço.'
    return
  }
  delete drafts.value[id]
}
function connectionText(row: FarmRow) {
  switch (row.connection) {
    case 'authenticated':
      return row.observation
        ? 'Conexão direta autenticada'
        : 'Conexão direta autenticada; aguardando estado.'
    case 'connecting':
      return 'Estabelecendo conexão direta…'
    case 'verifying':
      return 'Verificando conexão direta…'
    case 'closed':
      return row.observation
        ? 'Conexão direta indisponível. Exibindo a última observação.'
        : 'Conexão direta indisponível'
    case 'unavailable':
      return 'Conexão direta indisponível'
  }
}
function receiptAge(row: FarmRow) {
  if (!row.observation) return ''
  const seconds = observationAge(row.observation, now.value).seconds
  return seconds === null
    ? 'Horário de recebimento não confirmado'
    : seconds >= 86_400
      ? 'Atualização recebida há mais de 24 h'
      : `Atualização recebida há ${seconds} s`
}
function dateLabel(time: number) {
  return time <= 8_640_000_000_000_000
    ? new Date(time).toLocaleString('pt-BR')
    : 'Horário não confirmado'
}
</script>
<template>
  <main id="conteudo">
    <small>Open3DFarmManager</small>
    <h1 ref="heading" tabindex="-1">Minha farm</h1>
    <nav aria-label="Navegação da farm" class="actions">
      <NuxtLink to="/">Início</NuxtLink>
      <NuxtLink to="/impressoras">Impressoras</NuxtLink>
      <NuxtLink to="/parear">Connectors</NuxtLink>
      <NuxtLink to="/dispositivos">Dispositivos do navegador</NuxtLink>
      <NuxtLink to="/sair">Sair da conta</NuxtLink>
    </nav>
    <p>Os controles desta página estão em modo somente leitura.</p>
    <p v-if="state.kind === 'loading'" role="status" aria-busy="true">
      Carregando suas farms…
    </p>
    <section
      v-else-if="state.kind === 'sign-in-required'"
      aria-label="Acesso à farm"
    >
      <p>Entre na sua conta para consultar suas farms.</p>
      <NuxtLink to="/entrar">Entrar</NuxtLink>
    </section>
    <section v-else-if="state.kind === 'error'" aria-label="Falha na consulta">
      <p ref="errorSummary" role="alert" tabindex="-1">{{ errorText }}</p>
      <div class="actions">
        <button type="button" @click="discover()">Tentar novamente</button
        ><NuxtLink to="/entrar">Entrar novamente</NuxtLink>
      </div>
    </section>
    <template v-else-if="ready">
      <p class="opaque">Conta atual: {{ ready.accountId }}</p>
      <section aria-labelledby="farm-scope-heading">
        <h2 id="farm-scope-heading">Escolha da farm</h2>
        <label for="farm-scope">Farm atual</label>
        <select
          id="farm-scope"
          :value="ready.scope?.farmId ?? ''"
          @change="chooseFarm"
        >
          <option value="">Selecione uma farm</option>
          <option
            v-for="farm in ready.farms"
            :key="farm.farmId"
            :value="farm.farmId"
          >
            {{ farm.farmId }}
          </option>
        </select>
        <p v-if="ready.scope" class="opaque">
          Farm atual: {{ ready.scope.farmId }}
        </p>
        <p v-if="!ready.farms.length">
          {{
            ready.farmAfter || ready.nextFarm
              ? 'Nenhuma farm nesta página.'
              : 'Sua conta ainda não tem acesso a uma farm.'
          }}
        </p>
        <div class="actions">
          <button v-if="ready.farmAfter" type="button" @click="discover()">
            Primeira página de farms
          </button>
          <button
            v-if="ready.nextFarm"
            type="button"
            @click="discover(ready.nextFarm)"
          >
            Próximas farms
          </button>
        </div>
      </section>
      <template v-if="ready.scope">
        <section aria-label="Conexão e dispositivo do navegador">
          <p role="status">{{ connectionNotice }}</p>
          <p v-if="ready.keys.kind !== 'available'">
            Este navegador precisa de um dispositivo aprovado para receber o
            estado. {{ keyText }}
          </p>
          <template v-else>
            <label for="farm-device"
              >Dispositivo aprovado deste navegador</label
            >
            <select
              id="farm-device"
              :value="ready.keys.selected"
              @change="chooseKey"
            >
              <option value="">Selecione um dispositivo</option>
              <option
                v-for="key in ready.keys.choices"
                :key="key.keyId"
                :value="key.keyId"
              >
                {{ key.keyId }} · {{ key.thumbprint }}
              </option>
            </select>
            <p>A aprovação do dispositivo não confirma uma conexão direta.</p>
          </template>
          <NuxtLink to="/dispositivos"
            >Gerenciar dispositivos do navegador</NuxtLink
          >
        </section>
        <section
          aria-labelledby="printers-heading"
          :aria-busy="ready.inventory === 'loading'"
        >
          <h2 id="printers-heading">Impressoras atribuídas</h2>
          <p>
            O cadastro informa atribuições e aprovações. O estado da impressora
            depende da conexão direta.
          </p>
          <p v-if="ready.inventory === 'loading'" role="status">
            Carregando o cadastro de impressoras…
          </p>
          <template v-else>
            <div class="actions">
              <button
                type="button"
                @click="selectFarm(ready.scope.farmId, ready.printerAfter)"
              >
                Atualizar cadastro
              </button>
              <button
                v-if="ready.printerAfter"
                type="button"
                @click="selectFarm(ready.scope.farmId)"
              >
                Primeira página de atribuições
              </button>
              <button
                v-if="ready.nextPrinter"
                type="button"
                @click="selectFarm(ready.scope.farmId, ready.nextPrinter)"
              >
                Próximas atribuições
              </button>
            </div>
            <p v-if="ready.printerAfter">
              Exibindo outra página de atribuições.
            </p>
            <p v-if="!ready.rows.length">
              {{
                ready.printerAfter || ready.nextPrinter
                  ? 'Nenhuma atribuição nesta página.'
                  : 'Nenhuma impressora atribuída a esta farm.'
              }}
              <NuxtLink to="/impressoras">Gerenciar atribuições</NuxtLink>
            </p>
            <ul class="printers">
              <li
                v-for="row in renderedRows"
                :key="row.assignment.assignmentId"
              >
                <article
                  :aria-labelledby="`printer-${row.assignment.assignmentId}`"
                >
                  <h3
                    :id="`printer-${row.assignment.assignmentId}`"
                    class="opaque"
                  >
                    {{ row.assignment.printerKey }}
                  </h3>
                  <p>
                    {{
                      row.assignment.status === 'active'
                        ? 'Atribuição ativa'
                        : 'Atribuição revogada'
                    }}. Connector
                    {{
                      {
                        approved: 'aprovado',
                        pending: 'pendente',
                        revoked: 'revogado',
                      }[row.assignment.connectorStatus]
                    }}.
                  </p>
                  <dl>
                    <dt>Connector</dt>
                    <dd class="opaque">{{ row.assignment.agentId }}</dd>
                    <dt>Atribuição</dt>
                    <dd class="opaque">{{ row.assignment.assignmentId }}</dd>
                    <dt>Conexão direta</dt>
                    <dd>{{ connectionText(row) }}</dd>
                    <dt>Último estado informado</dt>
                    <dd>
                      {{
                        row.observation
                          ? printerStateLabel[row.observation.state.state]
                          : 'Nenhum estado recebido'
                      }}
                    </dd>
                  </dl>
                  <template v-if="row.observation">
                    <p>
                      {{ receiptAge(row) }}. Recebido neste navegador em
                      {{ dateLabel(row.observation.received.wall) }}.
                    </p>
                    <p
                      v-if="
                        observationAge(row.observation, now).sourceConfirmed
                      "
                    >
                      Observado pelo Connector em
                      {{ dateLabel(row.observation.state.observedAt) }}. Idade
                      da observação estimada a partir do relógio do Connector.
                    </p>
                    <p v-else>Horário da observação não confirmado</p>
                    <p v-if="observationAge(row.observation, now).stale">
                      Dados desatualizados. A impressora pode ter mudado de
                      estado.
                    </p>
                    <p v-if="row.observation.state.state === 'printing'">
                      <progress
                        :value="row.observation.state.progress"
                        :max="1"
                        :aria-labelledby="`progress-${row.assignment.assignmentId}`"
                      />
                      <span :id="`progress-${row.assignment.assignmentId}`"
                        >Progresso informado da impressão:
                        {{
                          Math.round(row.observation.state.progress * 100)
                        }}%</span
                      >
                    </p>
                  </template>
                  <template
                    v-if="
                      row.assignment.status === 'active' &&
                      row.assignment.connectorStatus !== 'revoked'
                    "
                  >
                    <template v-if="row.localOrigin">
                      <p class="opaque">
                        Interface local confirmada nesta aba:
                        {{ row.localOrigin }}
                      </p>
                      <a
                        :href="row.localOrigin"
                        target="_blank"
                        rel="noopener noreferrer"
                        referrerpolicy="no-referrer"
                        :aria-describedby="`local-help-${row.assignment.assignmentId}`"
                        >Abrir interface local de
                        <span class="opaque">{{
                          row.assignment.printerKey
                        }}</span></a
                      >
                      <p>Abre em outra aba.</p>
                    </template>
                    <button
                      type="button"
                      @click="setupLink(row.assignment.assignmentId)"
                    >
                      {{
                        row.localOrigin
                          ? 'Alterar interface local'
                          : 'Configurar interface local'
                      }}
                    </button>
                    <form
                      v-if="row.draft"
                      @submit.prevent="saveLink(row.assignment.assignmentId)"
                    >
                      <label :for="`origin-${row.assignment.assignmentId}`"
                        >Origem da interface local</label
                      >
                      <input
                        :id="`origin-${row.assignment.assignmentId}`"
                        v-model="row.draft.value"
                        type="url"
                        required
                        autocomplete="off"
                        spellcheck="false"
                        :aria-describedby="`local-help-${row.assignment.assignmentId}`"
                        @input="row.draft.confirmed = false"
                      />
                      <p class="opaque">
                        Origem para conferir:
                        {{
                          localInterfaceOrigin(row.draft.value) ??
                          'Informe uma origem válida.'
                        }}
                      </p>
                      <label class="confirmation"
                        ><input
                          v-model="row.draft.confirmed"
                          type="checkbox"
                          required
                        />Conferi que este endereço abre a interface local desta
                        impressora.</label
                      >
                      <p v-if="row.draft.error" role="alert">
                        {{ row.draft.error }}
                      </p>
                      <div class="actions">
                        <button type="submit">Confirmar interface local</button
                        ><button
                          type="button"
                          @click="delete drafts[row.assignment.assignmentId]"
                        >
                          Cancelar
                        </button>
                      </div>
                    </form>
                    <p :id="`local-help-${row.assignment.assignmentId}`">
                      Acessível apenas se este navegador alcançar a rede da
                      impressora. O endereço não foi verificado. O endereço fica
                      somente na memória desta aba e precisa ser confirmado
                      novamente após recarregar.
                    </p>
                  </template>
                  <p :id="`pause-help-${row.assignment.assignmentId}`">
                    Pausa indisponível. O controle seguro ainda não foi
                    habilitado.
                  </p>
                  <button
                    type="button"
                    disabled
                    :aria-describedby="`pause-help-${row.assignment.assignmentId}`"
                  >
                    Pausar impressão
                  </button>
                </article>
              </li>
            </ul>
          </template>
        </section>
      </template>
    </template>
  </main>
</template>

<style scoped>
nav,
section {
  margin-bottom: 1.5rem;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1rem;
  align-items: center;
}
button,
select,
input,
a {
  font: inherit;
}
button,
select,
input:not([type='checkbox']),
a {
  min-height: 2.75rem;
}
button,
select,
input:not([type='checkbox']) {
  padding: 0.6rem;
  max-width: 100%;
}
a {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.25em;
}
button {
  cursor: pointer;
}
button:disabled {
  cursor: not-allowed;
}
label {
  display: block;
  margin: 0.75rem 0 0.3rem;
}
select,
input[type='url'] {
  width: 100%;
  min-width: 0;
}
.opaque {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: normal;
}
.printers {
  padding: 0;
  list-style: none;
}
.printers li {
  border: 1px solid currentColor;
  padding: 1rem;
  margin: 1rem 0;
  min-width: 0;
}
h3 {
  margin: 0 0 0.75rem;
}
dt {
  font-weight: 600;
  margin-top: 0.75rem;
}
dd {
  margin: 0.25rem 0 0;
}
.confirmation {
  display: flex;
  gap: 0.65rem;
  align-items: center;
  min-height: 2.75rem;
}
input[type='checkbox'] {
  flex: 0 0 auto;
  width: 1.25rem;
  height: 1.25rem;
}
progress {
  display: block;
  max-width: 100%;
}
:is(button, select, input, a):focus-visible {
  outline: 3px solid currentColor;
  outline-offset: 3px;
}
@media (max-width: 400px) {
  main {
    padding-inline: 1rem;
  }
  .printers li {
    padding: 0.75rem;
  }
}
</style>
