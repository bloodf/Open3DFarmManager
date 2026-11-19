<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import ApprovalPanel from '../components/integrations/ApprovalPanel.vue'
import FarmBrowserDevice from '../components/farm/FarmBrowserDevice.vue'
import FarmControlDialog from '../components/farm/FarmControlDialog.vue'
import FarmOfflineSection from '../components/farm/FarmOfflineSection.vue'
import FarmPrinterInventory from '../components/farm/FarmPrinterInventory.vue'
import FarmScopeSelector from '../components/farm/FarmScopeSelector.vue'
import SpoolInventory from '../components/SpoolInventory.vue'
import { useFarmControlSession } from '../components/farm/use-farm-control-session.ts'
import { useFarmView } from '../composables/useFarmView.ts'
import { useLastKnownStates } from '../composables/useLastKnownStates.ts'
import { offlineCards } from '../composables/useLastKnownStates-core.ts'
import {
  filterFarmRows,
  type FarmFilter,
  type FarmSort,
} from '../utils/farm-filters.ts'
import { farmConnectionNotice, type FarmRow } from '../utils/farm-view.ts'

const {
  state,
  ready,
  now,
  discover,
  selectFarm,
  selectKey,
  confirmOrigin,
  cameraFor,
} = useFarmView()

const liveFeedConnected = computed(() =>
  (ready.value?.rows ?? []).some((row) => row.connection === 'authenticated'),
)
const lastKnown = useLastKnownStates({
  farmId: () => ready.value?.scope?.farmId,
  live: () => liveFeedConnected.value,
})
const offlineStates = computed(() =>
  offlineCards(ready.value?.rows ?? [], lastKnown.states.value),
)
const offlineVisible = computed(
  () => !liveFeedConnected.value && offlineStates.value.length > 0,
)

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
    default: {
      const _exhaustive: never = state.value.reason
      return _exhaustive
    }
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
    default: {
      const _exhaustive: never = keys.reason
      return _exhaustive
    }
  }
})

const query = ref('')
const filter = ref<FarmFilter>('all')
const sort = ref<FarmSort>('original')
function resetFilters() {
  query.value = ''
  filter.value = 'all'
  sort.value = 'original'
}
const renderedRows = computed(() =>
  filterFarmRows(
    ready.value?.rows ?? [],
    query.value,
    filter.value,
    sort.value,
    now.value,
  ).map((row) => ({
    ...row,
    draft: drafts.value[row.assignment.assignmentId],
  })),
)
const connectionNotice = computed(() =>
  farmConnectionNotice(ready.value?.rows ?? []),
)

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
function cancelLink(id: string) {
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
    default: {
      const _exhaustive: never = row.connection
      return _exhaustive
    }
  }
}
function liveNow() {
  void now.value
  return { wall: Date.now(), mono: performance.now() }
}

const {
  pauseEnabled,
  pauseDialog,
  pauseCancel,
  pauseTarget,
  pauseState,
  lastControlResults,
  pauseRemaining,
  pauseStatus,
  commandInFlight,
  availability,
  openControl,
  openPause,
  confirmControl,
  closePause,
  cancelPause,
} = useFarmControlSession({ ready, now })
</script>

<template>
  <main id="conteudo">
    <small>Open3DFarmManager</small>
    <h1 ref="heading" tabindex="-1">Minha farm</h1>
    <nav aria-label="Navegação da farm" class="actions">
      <NuxtLink to="/">Início</NuxtLink>
      <NuxtLink to="/arquivos">Arquivos</NuxtLink>
      <NuxtLink to="/impressoras">Impressoras</NuxtLink>
      <NuxtLink to="/parear">Connectors</NuxtLink>
      <NuxtLink to="/dispositivos">Dispositivos do navegador</NuxtLink>
      <NuxtLink to="/sair">Sair da conta</NuxtLink>
    </nav>
    <p>
      Os controles desta página são somente leitura, exceto a pausa, que exige
      confirmação e uma conexão direta segura.
    </p>
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
      <FarmScopeSelector
        :farms="ready.farms"
        :farm-id="ready.scope?.farmId ?? ''"
        :farm-after="ready.farmAfter"
        :next-farm="ready.nextFarm"
        @change="chooseFarm"
        @first-page="discover()"
        @next-page="discover($event)"
      />
      <template v-if="ready.scope">
        <ApprovalPanel :farm-id="ready.scope.farmId" />
        <FarmBrowserDevice
          :connection-notice="connectionNotice"
          :keys="ready.keys"
          :key-text="keyText"
          @change-key="chooseKey"
        />
        <SpoolInventory
          :items="ready.spools"
          :rows="ready.rows"
          :now="now"
          :connected="
            ready.rows.some((row) => row.connection === 'authenticated')
          "
        />
        <FarmPrinterInventory
          v-model:query="query"
          v-model:filter="filter"
          v-model:sort="sort"
          :farm-id="ready.scope.farmId"
          :inventory="ready.inventory"
          :printer-after="ready.printerAfter"
          :next-printer="ready.nextPrinter"
          :rows="ready.rows"
          :rendered-rows="renderedRows"
          :keys="ready.keys"
          :control-enabled="pauseEnabled"
          :command-in-flight="commandInFlight"
          :now="now"
          :last-control-results="lastControlResults"
          :connection-text="connectionText"
          :pause-availability="availability"
          :camera-for="cameraFor"
          :live-now="liveNow"
          @refresh="selectFarm(ready.scope.farmId, ready.printerAfter)"
          @first-page="selectFarm(ready.scope.farmId)"
          @next-page="selectFarm(ready.scope.farmId, $event)"
          @reset-filters="resetFilters"
          @action="
            (row, action, args, event) => openControl(row, action, event, args)
          "
          @pause="(row, event) => openPause(row, event)"
          @setup-origin="setupLink"
          @save-origin="saveLink"
          @cancel-origin="cancelLink"
        />
        <FarmOfflineSection
          v-if="offlineVisible"
          :states="offlineStates"
          :now-wall-ms="now.wall"
        />
      </template>
    </template>
    <FarmControlDialog
      v-model:pause-dialog="pauseDialog"
      v-model:pause-cancel="pauseCancel"
      :pause-target="pauseTarget"
      :pause-state="pauseState"
      :pause-remaining="pauseRemaining"
      :pause-status="pauseStatus"
      :confirm-control="confirmControl"
      :close-pause="closePause"
      :cancel-pause="cancelPause"
    />
  </main>
</template>

<style src="../components/farm/farm-page.css"></style>
