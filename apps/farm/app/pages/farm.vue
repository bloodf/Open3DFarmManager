<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import {
  filterFarmRows,
  groupFarmRows,
  readFarmWallQuery,
  summarizeFarmRows,
  writeFarmWallQuery,
} from '../utils/farm-filters.ts'
import SpoolInventory from '../components/SpoolInventory.vue'
import { useFarmView } from '../composables/useFarmView.ts'
import { useLastKnownStates } from '../composables/useLastKnownStates.ts'
import { offlineCards } from '../composables/useLastKnownStates-core.ts'
import LastKnownStates from '../components/farm/LastKnownStates.vue'
import ApprovalPanel from '../components/integrations/ApprovalPanel.vue'
import FarmScopeSelector from '../components/farm/FarmScopeSelector.vue'
import PrinterWallFilters from '../components/farm/PrinterWallFilters.vue'
import FarmDeviceSelector from '../components/farm/FarmDeviceSelector.vue'
import PrinterWallTable from '../components/farm/PrinterWallTable.vue'
import FarmPrinterCard from '../components/farm/FarmPrinterCard.vue'
import PrinterWallCard from '../components/farm/PrinterWallCard.vue'
import PrinterWallSummary from '../components/farm/PrinterWallSummary.vue'
import { useStatusSummary } from '../composables/useStatusSummary.ts'
import { wallCardProps } from '../utils/farm-wall-card.ts'
import FarmCardControls from '../components/farm/FarmCardControls.vue'
import CollectionHold from '../components/farm/CollectionHold.vue'
import PrinterAlerts from '../components/farm/PrinterAlerts.vue'
import { useFarmControls } from '../components/farm/useFarmControls.ts'
import { deriveAlerts } from '../utils/farm-alerts.ts'
import {
  farmConnectionNotice,
  formatPrinterStateLabel,
  observationAge,
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
import { COLLECTION_DIALOG_DESCRIPTION } from '../components/farm/collection-hold-view.ts'
import { farmViewErrorText } from '../utils/farm-view-error.ts'
import Button from '../components/ui/Button.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import ErrorState from '../components/ui/ErrorState.vue'
import Skeleton from '../components/ui/Skeleton.vue'
import StaleNotice from '../components/ui/StaleNotice.vue'
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
// The whole farm in one bounded request: counts and latest states even for
// printers outside the assignment page the wall lists.
const statusSummary = useStatusSummary({
  farmId: () => ready.value?.scope?.farmId,
})
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
const errorText = computed(() =>
  state.value.kind === 'error' ? farmViewErrorText(state.value.reason) : '',
)
const route = useRoute()
watch([() => route.query.farm, () => ready.value?.farms], ([farmId, farms]) => {
  if (
    typeof farmId === 'string' &&
    farms?.some((farm) => farm.farmId === farmId) &&
    ready.value?.scope?.farmId !== farmId
  )
    void selectFarm(farmId)
})

const router = useRouter()
const wallQuery = computed({
  get: () => ({
    ...readFarmWallQuery(route.query),
    groupBy:
      route.query.groupBy === undefined
        ? 'location'
        : readFarmWallQuery(route.query).groupBy,
  }),
  set: (value) => {
    void router.replace({
      query: {
        ...router.currentRoute.value.query,
        ...writeFarmWallQuery(value),
        groupBy: value.groupBy || 'none',
      },
      hash: route.hash,
    })
  },
})
const rows = computed(() => {
  const inventory = ready.value?.rows ?? []
  if (!offlineVisible.value) return inventory
  const storedIds = new Set(
    offlineStates.value.map((state) => state.assignmentId),
  )
  return inventory.filter((row) => !storedIds.has(row.assignment.assignmentId))
})
const facets = computed(() => {
  const fields = [
    { key: 'group', field: 'groupName', label: 'Grupo' },
    { key: 'location', field: 'location', label: 'Local' },
    { key: 'connector', field: 'agentId', label: 'Connector' },
  ] as const
  return fields.map(({ key, field, label }) => {
    const options = new Set(
      rows.value
        .map((row) => row.assignment[field])
        .filter((value): value is string => !!value),
    )
    if (wallQuery.value[key]) options.add(wallQuery.value[key])
    return {
      key,
      label,
      options: [...options].sort((a, b) => a.localeCompare(b, 'pt-BR')),
    }
  })
})
const renderedRows = computed(() => {
  const filters = wallQuery.value
  return filterFarmRows(
    rows.value,
    filters.query,
    filters.filter,
    filters.sort,
    now.value,
    filters,
  ).map((row) => ({ ...row, draft: drafts.value[row.assignment.assignmentId] }))
})
const counts = computed(() => summarizeFarmRows(renderedRows.value, now.value))
// role="status" announces only live <-> unavailable; per-row text shows transient steps.
const connectionNotice = computed(() =>
  farmConnectionNotice(ready.value?.rows ?? []),
)
const alertsSummary = computed(() => deriveAlerts(ready.value, now.value))
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
const inspector = ref<HTMLDialogElement | null>(null)
const inspectedId = ref<string | null>(null)
const inspectedRow = computed(
  () =>
    renderedRows.value.find(
      (row) => row.assignment.assignmentId === inspectedId.value,
    ) ?? null,
)
watch(inspectedRow, (row) => {
  if (!row && inspector.value?.open) inspector.value.close()
})
let inspectorTrigger: HTMLElement | null = null
async function openInspector(
  row: (typeof renderedRows.value)[number],
  event: Event,
) {
  inspectorTrigger = event.currentTarget as HTMLElement
  inspectedId.value = row.assignment.assignmentId
  await nextTick()
  inspector.value?.showModal()
}
function closeInspector() {
  inspector.value?.close()
}
function inspectorClosed() {
  inspectedId.value = null
  inspectorTrigger?.focus()
  inspectorTrigger = null
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
  <main id="conteudo" class="farm-page">
    <header class="page-header">
      <p class="eyebrow">Open3DFarmManager</p>
      <h1 ref="heading" tabindex="-1">Minha farm</h1>
      <p class="intro">
        Os comandos exigem confirmação e conexão direta segura. Sem conexão
        direta, a operação é somente leitura.
      </p>
      <nav aria-label="Navegação da farm">
        <ul class="nav-links">
          <li><NuxtLink to="/">Início</NuxtLink></li>
          <li><NuxtLink to="/arquivos">Arquivos</NuxtLink></li>
          <li><NuxtLink to="/impressoras">Impressoras</NuxtLink></li>
          <li><NuxtLink to="/parear">Connectors</NuxtLink></li>
          <li>
            <NuxtLink to="/dispositivos">Dispositivos do navegador</NuxtLink>
          </li>
          <li><NuxtLink to="/sair">Sair da conta</NuxtLink></li>
        </ul>
      </nav>
    </header>
    <div v-if="state.kind === 'loading'" class="loading panel" aria-busy="true">
      <p role="status">Carregando suas farms…</p>
      <Skeleton /><Skeleton /><Skeleton />
    </div>
    <section
      v-else-if="state.kind === 'sign-in-required'"
      aria-label="Acesso à farm"
      class="panel"
    >
      <h2>Entre para ver a farm</h2>
      <p>Entre na sua conta para consultar suas farms.</p>
      <NuxtLink to="/entrar" class="cta">Entrar</NuxtLink>
    </section>
    <ErrorState
      v-else-if="state.kind === 'error'"
      title="Não foi possível carregar suas farms"
    >
      <p ref="errorSummary" role="alert" tabindex="-1">{{ errorText }}</p>
      <div class="actions">
        <Button @click="discover()">Tentar novamente</Button>
        <NuxtLink to="/entrar">Entrar novamente</NuxtLink>
      </div>
    </ErrorState>
    <div v-else-if="ready" class="stack">
      <p class="opaque account">Conta atual: {{ ready.accountId }}</p>
      <div class="setup-grid">
        <FarmScopeSelector
          :ready="ready"
          @select="selectFarm"
          @discover="discover"
        />
        <FarmDeviceSelector
          v-if="ready.scope"
          :keys="ready.keys"
          :connection-notice="connectionNotice"
          @select="selectKey"
        />
      </div>
      <template v-if="ready.scope">
        <ApprovalPanel :farm-id="ready.scope.farmId" />
        <SpoolInventory
          :items="ready.spools"
          :rows="ready.rows"
          :now="now"
          :connected="
            ready.rows.some((row) => row.connection === 'authenticated')
          "
        />
        <PrinterAlerts :alerts="alertsSummary" />
        <PrinterWallSummary
          :summary="statusSummary.summary.value"
          :fetched-at="statusSummary.fetchedAt.value"
          :failed="statusSummary.failed.value"
          :now-wall-ms="liveNow().wall"
        />
        <section
          class="panel"
          aria-labelledby="printers-heading"
          :aria-busy="ready.inventory === 'loading'"
        >
          <h2 id="printers-heading">Impressoras atribuídas</h2>
          <p>
            O cadastro informa atribuições e aprovações. O estado da impressora
            depende da conexão direta.
          </p>
          <div
            v-if="ready.inventory === 'loading'"
            class="loading"
            aria-busy="true"
          >
            <p role="status">Carregando o cadastro de impressoras…</p>
            <Skeleton /><Skeleton /><Skeleton />
          </div>
          <template v-else>
            <div class="actions toolbar">
              <Button
                @click="selectFarm(ready.scope.farmId, ready.printerAfter)"
              >
                Atualizar cadastro
              </Button>
              <Button
                v-if="ready.printerAfter"
                @click="selectFarm(ready.scope.farmId)"
              >
                Primeira página de atribuições
              </Button>
              <Button
                v-if="ready.nextPrinter"
                @click="selectFarm(ready.scope.farmId, ready.nextPrinter)"
              >
                Próximas atribuições
              </Button>
            </div>
            <p v-if="ready.printerAfter">
              Exibindo outra página de atribuições.
            </p>
            <EmptyState
              v-if="!ready.rows.length"
              :title="
                ready.printerAfter || ready.nextPrinter
                  ? 'Nenhuma atribuição nesta página.'
                  : 'Nenhuma impressora atribuída a esta farm.'
              "
              description="Atribua uma impressora a um Connector para acompanhar o estado dela aqui."
            >
              <NuxtLink to="/impressoras">Gerenciar atribuições</NuxtLink>
            </EmptyState>
            <form
              v-if="rows.length"
              role="search"
              aria-label="Filtrar impressoras"
              class="filters"
              @submit.prevent
            >
              <PrinterWallFilters
                v-model="wallQuery"
                :facets="facets"
                :counts="counts"
                :total="rows.length"
                :visible="renderedRows.length"
              />
            </form>
            <PrinterWallTable
              v-if="rows.length"
              v-slot="{ rows: wallRows }"
              :rows="renderedRows"
              :live-now="liveNow"
            >
              <template
                v-for="group in groupFarmRows(wallRows, wallQuery.groupBy)"
                :key="group.key ?? ''"
              >
                <h3 v-if="wallQuery.groupBy">
                  {{
                    group.key ??
                    (wallQuery.groupBy === 'groupName'
                      ? 'Sem grupo'
                      : 'Sem local')
                  }}
                </h3>
                <ul class="printers">
                  <li
                    v-for="row in group.rows"
                    :key="row.assignment.assignmentId"
                    class="floor-tile"
                    :data-state="
                      row.connection !== 'authenticated'
                        ? 'offline'
                        : (row.observation?.state.state ?? 'offline')
                    "
                  >
                    <button
                      type="button"
                      class="floor-tile__open"
                      @click="openInspector(row, $event)"
                    >
                      <span>Inspecionar</span>
                      <strong>{{
                        row.assignment.displayName || row.assignment.printerKey
                      }}</strong>
                      <span>{{
                        row.connection !== 'authenticated'
                          ? 'Sem conexão direta'
                          : row.observation
                            ? formatPrinterStateLabel(row.observation.state)
                            : 'Aguardando estado'
                      }}</span>
                      <span
                        v-if="
                          row.observation &&
                          observationAge(row.observation, liveNow()).stale
                        "
                        >Dados desatualizados</span
                      >
                      <span v-if="row.observation?.state.filename">{{
                        row.observation.state.filename
                      }}</span>
                    </button>
                    <CollectionHold
                      :row="row"
                      :keys="ready.keys"
                      :control-enabled="pauseEnabled"
                      :command-in-flight="commandInFlight"
                      :open-control="openControl"
                    />
                  </li>
                </ul>
              </template>
            </PrinterWallTable>
          </template>
        </section>
        <section
          v-if="offlineVisible"
          class="panel"
          aria-labelledby="last-known-heading"
          aria-describedby="last-known-description"
        >
          <h2 id="last-known-heading">Última observação conhecida</h2>
          <StaleNotice
            id="last-known-description"
            description="Sem conexão direta, estes são os últimos estados que o servidor observou. As informações são somente leitura e podem estar desatualizadas."
          />
          <ul class="last-known-list">
            <li v-for="state in offlineStates" :key="state.assignmentId">
              <LastKnownStates :state="state" :now-wall-ms="now.wall" />
            </li>
          </ul>
        </section>
      </template>
    </div>
    <dialog
      ref="inspector"
      v-if="ready?.scope"
      class="floor-inspector"
      aria-label="Inspeção da impressora"
      @close="inspectorClosed"
    >
      <button
        type="button"
        class="floor-inspector__close"
        @click="closeInspector"
      >
        Fechar inspeção
      </button>
      <ul class="inspector-list">
        <FarmPrinterCard
          v-if="inspectedRow"
          :key="inspectedRow.assignment.assignmentId"
          :row="inspectedRow"
          :farm-id="ready.scope.farmId"
          :camera-for="cameraFor"
          :live-now="liveNow"
          :alerts="
            alertsSummary.byAssignment[inspectedRow.assignment.assignmentId] ??
            []
          "
          @setup="setupLink(inspectedRow.assignment.assignmentId)"
          @save="saveLink(inspectedRow.assignment.assignmentId)"
          @cancel="delete drafts[inspectedRow.assignment.assignmentId]"
        >
          <template #summary>
            <PrinterWallCard
              v-bind="
                wallCardProps(
                  inspectedRow,
                  alertsSummary.byAssignment[
                    inspectedRow.assignment.assignmentId
                  ] ?? [],
                )
              "
              :now="liveNow()"
              :heading-level="wallQuery.groupBy ? 4 : 3"
              embedded
            />
          </template>
          <template #local-link="{ row }">
            <a
              :href="displayLocalOrigin(row) ?? undefined"
              target="_blank"
              rel="noopener noreferrer"
              referrerpolicy="no-referrer"
              :aria-describedby="`local-help-${row.assignment.assignmentId}`"
              >Abrir interface local de
              <span class="opaque">{{ row.assignment.printerKey }}</span></a
            >
          </template>
          <FarmCardControls
            :row="inspectedRow"
            :keys="ready.keys"
            :control-enabled="pauseEnabled"
            :command-in-flight="commandInFlight"
            :live-now="liveNow"
            :last-result="
              lastControlResults[inspectedRow.assignment.assignmentId]
            "
            :availability="availability"
            :open-control="openControl"
            :show-collection="false"
          />
        </FarmPrinterCard>
      </ul>
    </dialog>
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
              : pauseTarget.action === 'confirm_collection'
                ? COLLECTION_DIALOG_DESCRIPTION
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
                : pauseTarget.action === 'confirm_collection'
                  ? 'Confirmar placa livre'
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
<style scoped>
.farm-page {
  display: grid;
  gap: var(--space-4);
  align-content: start;
}
.page-header {
  display: grid;
  gap: var(--space-2);
}
.eyebrow {
  margin: 0;
  font-size: var(--font-size-sm);
  letter-spacing: 0.04em;
  color: var(--color-text-muted);
}
.page-header h1 {
  width: fit-content;
  max-width: 100%;
  margin: 0;
  overflow-wrap: anywhere;
}
.page-header h1:focus-visible,
.stack [role='alert']:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
  border-radius: var(--radius-sm);
}
.intro {
  margin: 0;
  color: var(--color-text-muted);
}
.nav-links {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin: var(--space-2) 0 0;
  padding: 0;
  list-style: none;
}
.nav-links a,
.cta {
  padding: var(--space-2) var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  text-decoration: none;
  font-weight: var(--font-weight-semibold);
}
.nav-links a:hover,
.cta:hover {
  border-color: var(--color-accent);
}
.nav-links a[aria-current='page'],
.nav-links a.router-link-exact-active {
  border-color: var(--color-accent);
}
.cta {
  justify-self: start;
  border-color: var(--color-accent);
  background: var(--color-accent);
  color: var(--color-on-accent);
}
.stack {
  display: grid;
  gap: var(--space-4);
  min-width: 0;
}
.stack > :deep(section),
.setup-grid > :deep(section),
.panel {
  margin: 0;
  padding: var(--space-5);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  min-width: 0;
}
.panel > h2,
.stack > :deep(section) > h2,
.setup-grid > :deep(section) > h2 {
  margin: 0 0 var(--space-3);
  font-size: var(--font-size-lg);
  line-height: var(--line-height-tight);
}
.panel > p,
.stack > :deep(section) > p,
.setup-grid > :deep(section) > p {
  margin-block: 0 var(--space-3);
}
.account {
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}
.setup-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr));
  gap: var(--space-4);
  align-items: start;
}
.toolbar {
  margin-bottom: var(--space-4);
}
.filters {
  margin-block: var(--space-4);
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  columns: 14rem 3;
  column-gap: var(--space-5);
}
.filters :deep(label) {
  margin: 0 0 var(--space-1);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  break-after: avoid;
}
.filters :deep(select),
.filters :deep(input[type='search']),
.filters :deep(button) {
  width: 100%;
  margin-bottom: var(--space-3);
  break-inside: avoid;
  color: inherit;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}
.filters :deep(button) {
  background: var(--color-surface-raised);
  border-color: var(--color-accent);
  color: var(--color-accent);
}
.filters :deep(ul),
.filters :deep(p) {
  column-span: all;
}
.filters :deep(ul) {
  margin: var(--space-2) 0;
  padding: 0;
  list-style: none;
  gap: var(--space-1) var(--space-4);
  font-size: var(--font-size-sm);
}
.filters :deep(p) {
  margin: 0 0 var(--space-1);
  font-weight: var(--font-weight-semibold);
}
.printers {
  gap: var(--space-4);
}
.printers > :deep(.printer-card) {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  margin: 0;
}
.last-known-list {
  display: grid;
  gap: var(--space-3);
  margin: 0;
}
dialog {
  color: var(--color-text);
  background: var(--color-surface-raised);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--elevation-2);
}
dialog h2 {
  margin-top: 0;
  font-size: var(--font-size-lg);
  overflow-wrap: anywhere;
}
dialog .actions {
  margin-top: var(--space-4);
}
dialog .actions button {
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-sm);
  background: var(--color-surface-raised);
  color: var(--color-accent);
}
dialog .actions button:first-child:not(:disabled) {
  background: var(--color-accent);
  color: var(--color-on-accent);
}
dialog .actions button:disabled {
  opacity: 0.6;
}
@media (max-width: 400px) {
  .stack > :deep(section),
  .setup-grid > :deep(section),
  .panel {
    padding: var(--space-4);
  }
  .nav-links a {
    padding-inline: var(--space-3);
  }
}
@media (prefers-reduced-motion: no-preference) {
  .nav-links a,
  .cta {
    transition: border-color 120ms ease-out;
  }
}
</style>

<style scoped>
.floor-tile {
  min-width: 0;
  border: 1px solid var(--ops-border);
  border-radius: var(--ops-radius-lg);
  background: var(--ops-panel);
  color: var(--ops-text);
  overflow-wrap: anywhere;
}
.floor-tile[data-state='offline'] {
  background: var(--ops-offline-hatch);
}
.floor-tile__open {
  display: grid;
  width: 100%;
  gap: var(--ops-space-2);
  padding: var(--ops-space-3);
  border: 0;
  border-inline-start: 4px solid var(--ops-idle);
  background: transparent;
  color: inherit;
  text-align: start;
  cursor: pointer;
}
.floor-tile[data-state='printing'] .floor-tile__open {
  border-inline-start-color: var(--ops-printing);
}
.floor-tile[data-state='paused'] .floor-tile__open {
  border-inline-start-color: var(--ops-attention);
}
.floor-tile[data-state='error'] .floor-tile__open {
  border-inline-start-color: var(--ops-fault);
}
.floor-tile__open span {
  font-size: var(--ops-text-small);
}
.floor-tile__open span:nth-child(3) {
  width: fit-content;
  padding: var(--ops-space-1);
  color: var(--ops-idle);
  background: var(--ops-idle-bg);
}
.floor-tile[data-state='printing'] .floor-tile__open span:nth-child(3) {
  color: var(--ops-printing);
  background: var(--ops-printing-bg);
}
.floor-tile[data-state='paused'] .floor-tile__open span:nth-child(3) {
  color: var(--ops-attention);
  background: var(--ops-attention-bg);
}
.floor-tile[data-state='error'] .floor-tile__open span:nth-child(3) {
  color: var(--ops-fault);
  background: var(--ops-fault-bg);
}
.floor-tile[data-state='offline'] .floor-tile__open span:nth-child(3) {
  color: var(--ops-offline);
  background: var(--ops-offline-bg);
}
.floor-tile :deep(.collection-hold) {
  margin: var(--ops-space-2);
}
.floor-inspector {
  position: fixed;
  inset: 0 0 0 auto;
  margin: 0;
  width: min(36rem, 100vw);
  max-width: 100vw;
  height: 100dvh;
  max-height: 100dvh;
  overflow: auto;
  border: 0;
  border-inline-start: 1px solid var(--ops-border);
  background: var(--ops-panel);
  color: var(--ops-text);
}
.floor-inspector::backdrop {
  background: color-mix(in srgb, var(--ops-text) 50%, transparent);
}
.inspector-list {
  list-style: none;
  padding: 0;
}
</style>
