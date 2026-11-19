<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import {
  filterFarmRows,
  type FarmFilter,
  type FarmSort,
} from '../utils/farm-filters.ts'
import SpoolInventory from '../components/SpoolInventory.vue'
import { useFarmView } from '../composables/useFarmView.ts'
import { useLastKnownStates } from '../composables/useLastKnownStates.ts'
import { offlineCards } from '../composables/useLastKnownStates-core.ts'
import LastKnownStates from '../components/farm/LastKnownStates.vue'
import ApprovalPanel from '../components/integrations/ApprovalPanel.vue'
import FarmScopeSelector from '../components/farm/FarmScopeSelector.vue'
import FarmFilters from '../components/farm/FarmFilters.vue'
import FarmDeviceSelector from '../components/farm/FarmDeviceSelector.vue'
import FarmPrinterCard from '../components/farm/FarmPrinterCard.vue'
import FarmCardControls from '../components/farm/FarmCardControls.vue'
import { useFarmControls } from '../components/farm/useFarmControls.ts'
import {
  farmConnectionNotice,
  resolvedLocalInterfaceOrigin,
  type FarmRow,
} from '../utils/farm-view.ts'
import type { ControlAction } from '../../../../packages/farm-protocol/src/control-actions.ts'
import {
  actionButtonConfirmationLabel,
  actionDialogDescription,
  actionDialogTitle,
} from '../utils/farm-control.ts'
import { extendedLabel } from '../utils/farm-control-extended.ts'
const view = useFarmView()
const {
  state,
  ready,
  now,
  discover,
  selectFarm,
  selectKey,
  confirmOrigin,
  cameraFor,
} = view

// A live feed owns the printers it reports. While none is authenticated, the
// stored last known states are read so the page is not empty.
const liveFeedConnected = computed(() =>
  (ready.value?.rows ?? []).some((row) => row.connection === 'authenticated'),
)
const lastKnown = useLastKnownStates({
  farmId: () => ready.value?.scope?.farmId,
  live: () => liveFeedConnected.value,
})
// The live rows win: a printer the feed reports never gains a second card
// from the stored snapshot.
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
  }
})
const query = ref('')
const filter = ref<FarmFilter>('all')
const sort = ref<FarmSort>('original')
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
// role="status" announces only live <-> unavailable; per-row text shows transient steps.
const connectionNotice = computed(() =>
  farmConnectionNotice(ready.value?.rows ?? []),
)
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
// Reads the once-a-second tick for reactivity, but measures against a fresh
// sample so a frame received after the last tick never shows a negative age.
function liveNow() {
  void now.value
  return { wall: Date.now(), mono: performance.now() }
}
function displayLocalOrigin(row: FarmRow) {
  return resolvedLocalInterfaceOrigin(
    row.localOrigin,
    row.observation?.state.localWebUiOrigin,
  )
}
const pauseDialog = ref<HTMLDialogElement | null>(null)
const pauseCancel = ref<HTMLButtonElement | null>(null)
const dialog = {
  value: {
    show() {
      pauseDialog.value?.showModal()
      pauseCancel.value?.focus()
    },
    close() {
      pauseDialog.value?.close()
    },
  },
}
const {
  pauseEnabled,
  availability,
  pauseTarget,
  pauseState,
  lastControlResults,
  pauseRemaining,
  pauseStatus,
  openControl,
  confirmControl,
  closePause,
  commandInFlight,
} = useFarmControls(view, dialog)
function cancelPause(event: Event) {
  // Esc closes the dialog, but never interrupts a command in flight.
  event.preventDefault()
  closePause()
}
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
        :ready="ready"
        @select="selectFarm"
        @discover="discover"
      />
      <template v-if="ready.scope">
        <ApprovalPanel :farm-id="ready.scope.farmId" />
        <FarmDeviceSelector
          :keys="ready.keys"
          :connection-notice="connectionNotice"
          @select="selectKey"
        />
        <SpoolInventory
          :items="ready.spools"
          :rows="ready.rows"
          :now="now"
          :connected="
            ready.rows.some((row) => row.connection === 'authenticated')
          "
        />
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
            <FarmFilters
              v-model:query="query"
              v-model:filter="filter"
              v-model:sort="sort"
              :total="ready.rows.length"
              :visible="renderedRows.length"
            />
            <ul class="printers">
              <FarmPrinterCard
                v-for="row in renderedRows"
                :key="row.assignment.assignmentId"
                :row="row"
                :farm-id="ready.scope.farmId"
                :camera-for="cameraFor"
                :live-now="liveNow"
                @setup="setupLink(row.assignment.assignmentId)"
                @save="saveLink(row.assignment.assignmentId)"
                @cancel="delete drafts[row.assignment.assignmentId]"
              >
                <template #local-link>
                  <a
                    :href="displayLocalOrigin(row) ?? undefined"
                    target="_blank"
                    rel="noopener noreferrer"
                    referrerpolicy="no-referrer"
                    :aria-describedby="`local-help-${row.assignment.assignmentId}`"
                    >Abrir interface local de
                    <span class="opaque">{{
                      row.assignment.printerKey
                    }}</span></a
                  >
                </template>
                <FarmCardControls
                  :row="row"
                  :keys="ready.keys"
                  :control-enabled="pauseEnabled"
                  :command-in-flight="commandInFlight"
                  :live-now="liveNow"
                  :last-result="lastControlResults[row.assignment.assignmentId]"
                  :availability="availability"
                  :open-control="openControl"
                />
              </FarmPrinterCard>
            </ul>
          </template>
        </section>
        <section
          v-if="offlineVisible"
          aria-labelledby="last-known-heading"
          aria-describedby="last-known-description"
        >
          <h2 id="last-known-heading">Última observação conhecida</h2>
          <p id="last-known-description">
            Sem conexão direta, estes são os últimos estados que o servidor
            observou. As informações são somente leitura e podem estar
            desatualizadas.
          </p>
          <ul class="last-known-list">
            <li v-for="state in offlineStates" :key="state.assignmentId">
              <LastKnownStates :state="state" :now-wall-ms="now.wall" />
            </li>
          </ul>
        </section>
      </template>
    </template>
    <dialog
      ref="pauseDialog"
      aria-labelledby="pause-dialog-title"
      aria-describedby="pause-dialog-description"
      @cancel="cancelPause"
    >
      <template v-if="pauseTarget">
        <h2 id="pause-dialog-title">
          {{
            ['pause', 'resume', 'cancel'].includes(pauseTarget.action)
              ? actionDialogTitle(
                  pauseTarget.action as ControlAction,
                  pauseTarget.printerKey,
                )
              : `${extendedLabel(pauseTarget.action)}${pauseTarget.action === 'run_macro' ? ` ${pauseTarget.args.name}` : ''} — ${pauseTarget.printerKey}`
          }}
        </h2>
        <p id="pause-dialog-description">
          {{
            ['pause', 'resume', 'cancel'].includes(pauseTarget.action)
              ? actionDialogDescription(
                  pauseTarget.action as ControlAction,
                  pauseTarget.printerKey,
                )
              : 'Confirme o comando para esta impressora. Ele será enviado diretamente ao Connector e não será repetido automaticamente.'
          }}
        </p>
        <p role="status" aria-live="polite">{{ pauseStatus }}</p>
        <div class="actions">
          <button
            type="button"
            :disabled="pauseState.kind !== 'ready' || pauseRemaining <= 0"
            @click="confirmControl"
          >
            {{
              ['pause', 'resume', 'cancel'].includes(pauseTarget.action)
                ? actionButtonConfirmationLabel(
                    pauseTarget.action as ControlAction,
                  )
                : 'Confirmar comando'
            }}
          </button>
          <button
            ref="pauseCancel"
            type="button"
            :disabled="pauseState.kind === 'sending'"
            @click="closePause"
          >
            {{
              pauseState.kind === 'settled' || pauseState.kind === 'failed'
                ? 'Fechar'
                : 'Cancelar'
            }}
          </button>
        </div>
      </template>
    </dialog>
  </main>
</template>

<style scoped src="../components/farm/farm-view.css"></style>
