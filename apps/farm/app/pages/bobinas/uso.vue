<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import Button from '../../components/ui/Button.vue'
import Dialog from '../../components/ui/Dialog.vue'
import EmptyState from '../../components/ui/EmptyState.vue'
import ErrorState from '../../components/ui/ErrorState.vue'
import Skeleton from '../../components/ui/Skeleton.vue'
import FeaturePanel from '../../components/spool-library/FeaturePanel.vue'
import FeatureTable from '../../components/spool-library/FeatureTable.vue'
import SpoolIllustration from '../../components/spool-library/SpoolIllustration.vue'
import SpoolLibraryShell from '../../components/spool-library/SpoolLibraryShell.vue'
import {
  featureFetch,
  fetchPrinters,
  fetchSpools,
  useSpoolFeaturePage,
} from '../../composables/useSpoolFeaturePage.ts'
import {
  formatGrams,
  formatMoney,
  formatStamp,
  GROUP_BY_OPTIONS,
  parseAmount,
} from '../../utils/spool-features-format.ts'
import type {
  PrinterRef,
  UsageGroupBy,
  UsageListResponse,
  UsageRecord,
  UsageReport,
  UsageReportRow,
} from '../../utils/spool-features-types.ts'
import { spoolDisplayTitle } from '../../utils/spool-library-format.ts'
import type { SpoolItem } from '../../utils/spool-library-types.ts'

const printers = ref<PrinterRef[]>([])
const spools = ref<SpoolItem[]>([])
const records = ref<UsageRecord[]>([])
const report = ref<UsageReport | null>(null)
const currency = ref('USD')
const canWrite = ref(false)
const busy = ref(false)
const filters = reactive({ printerId: '', spoolId: '', jobId: '' })
const groupBy = ref<UsageGroupBy>('job')

const correcting = ref<UsageRecord | null>(null)
const correctOpen = ref(false)
const correctGrams = ref('')
const correctError = ref('')

const manualOpen = ref(false)
const manual = reactive({ spoolId: '', grams: '', printerId: '' })
const manualError = ref('')

function usageQuery(): Record<string, string> {
  const query: Record<string, string> = {}
  if (filters.printerId) query.printerId = filters.printerId
  if (/^\d+$/.test(filters.spoolId)) query.spoolId = filters.spoolId
  if (/^\d+$/.test(filters.jobId)) query.jobId = filters.jobId
  return query
}

async function loadUsage(farmId: string) {
  const query = usageQuery()
  const [list, summary] = await Promise.all([
    featureFetch<UsageListResponse>(farmId, 'usage', { query }),
    featureFetch<UsageReport>(farmId, 'reports/usage', {
      query: { ...query, groupBy: groupBy.value },
    }),
  ])
  records.value = list.records
  currency.value = list.currency
  report.value = summary
}

async function load(farmId: string) {
  const [printerList, spoolList] = await Promise.all([
    fetchPrinters(farmId),
    fetchSpools(farmId),
  ])
  printers.value = printerList
  spools.value = spoolList.items
  canWrite.value = spoolList.canWrite
  await loadUsage(farmId)
}

const page = useSpoolFeaturePage(load)
const {
  farms,
  farmId,
  loadingFarm,
  farmLoadError,
  signInRequired,
  noFarm,
  loading,
  error,
  statusMessage,
  actionError,
  selectFarm,
} = page

const spoolById = computed(
  () => new Map(spools.value.map((spool) => [spool.id, spool])),
)
const printerKeyById = computed(
  () => new Map(printers.value.map((p) => [p.assignmentId, p.printerKey])),
)

const recordColumns = [
  { id: 'when', label: 'Data' },
  { id: 'spool', label: 'Bobina' },
  { id: 'printer', label: 'Impressora' },
  { id: 'job', label: 'Trabalho' },
  { id: 'grams', label: 'Consumo' },
  { id: 'cost', label: 'Custo' },
  { id: 'source', label: 'Origem' },
  { id: 'action', label: 'Ações' },
]
const SOURCE_LABELS: Record<string, string> = {
  telemetry: 'Telemetria',
  manual: 'Manual',
  api: 'API',
}
const summaryColumns = computed(() => {
  const first = GROUP_BY_OPTIONS.find((o) => o.value === groupBy.value)
  return [
    { id: 'group', label: first?.label.replace('Por ', '') ?? 'Grupo' },
    { id: 'records', label: 'Registros' },
    { id: 'grams', label: 'Consumo' },
    { id: 'cost', label: 'Custo' },
  ]
})

function spoolText(id: number): string {
  const spool = spoolById.value.get(id)
  return spool ? `#${id} · ${spoolDisplayTitle(spool)}` : `#${id}`
}

function groupLabel(row: UsageReportRow): string {
  if (groupBy.value === 'job')
    return row.jobId == null ? 'Sem trabalho' : `Trabalho #${row.jobId}`
  if (groupBy.value === 'printer')
    return row.printerKey ?? row.printerId ?? 'Sem impressora'
  if (groupBy.value === 'filament')
    return [row.filamentName ?? `Filamento #${row.filamentId}`, row.material]
      .filter(Boolean)
      .join(' · ')
  return row.period ?? '—'
}

function costText(value: number | null, unpriced = 0): string {
  const text = formatMoney(value, currency.value)
  return unpriced > 0 && value !== null
    ? `${text} (+${unpriced} sem preço)`
    : text
}

async function applyFilters() {
  if (!farmId.value) return
  await page.act(
    () => loadUsage(farmId.value),
    'Uso atualizado.',
    'Não foi possível filtrar o uso.',
  )
}

function openCorrect(record: UsageRecord) {
  correcting.value = record
  correctGrams.value = String(record.grams)
  correctError.value = ''
  correctOpen.value = true
}

async function submitCorrect() {
  const record = correcting.value
  const parsed = parseAmount(correctGrams.value, { max: 1_000_000 })
  if (!record || busy.value) return
  if (!parsed.ok) {
    correctError.value = parsed.error
    return
  }
  busy.value = true
  const ok = await page.act(
    async () => {
      await featureFetch(farmId.value, `usage/${record.id}`, {
        method: 'PATCH',
        body: { grams: parsed.value },
      })
      await load(farmId.value)
    },
    `Consumo corrigido para ${formatGrams(parsed.value)} na bobina #${record.spoolId}.`,
    'Não foi possível corrigir o consumo.',
  )
  busy.value = false
  if (ok) correctOpen.value = false
  else correctError.value = actionError.value
}

async function submitManual() {
  const grams = parseAmount(manual.grams, { min: 0.1, max: 1_000_000 })
  const spoolId = Number(manual.spoolId)
  if (busy.value) return
  if (!Number.isSafeInteger(spoolId) || spoolId < 1) {
    manualError.value = 'Escolha uma bobina.'
    return
  }
  if (!grams.ok) {
    manualError.value = grams.error
    return
  }
  busy.value = true
  const ok = await page.act(
    async () => {
      await featureFetch(farmId.value, 'usage', {
        method: 'POST',
        body: {
          spoolId,
          grams: grams.value,
          ...(manual.printerId ? { printerId: manual.printerId } : {}),
        },
      })
      await load(farmId.value)
    },
    `Consumo de ${formatGrams(grams.value)} registrado na bobina #${spoolId}.`,
    'Não foi possível registrar o consumo.',
  )
  busy.value = false
  if (ok) {
    manualOpen.value = false
    manual.grams = ''
  } else manualError.value = actionError.value
}
</script>

<template>
  <SpoolLibraryShell
    section="usage"
    title="Uso e custo por impressão"
    description="Consumo de filamento por trabalho e impressora, custo de cada impressão e correção de registros."
    :farms="farms"
    :farm-id="farmId"
    :loading="loadingFarm"
    :load-error="farmLoadError"
    :sign-in-required="signInRequired"
    :no-farm="noFarm"
    :status-message="statusMessage"
    @retry="page.retry"
    @select-farm="selectFarm"
  >
    <p
      v-if="actionError && !correctOpen && !manualOpen"
      role="alert"
      class="error-line"
    >
      {{ actionError }}
    </p>

    <div v-if="loading" aria-busy="true">
      <p role="status">Carregando uso…</p>
      <Skeleton />
    </div>
    <ErrorState
      v-else-if="error"
      title="Não foi possível carregar o uso"
      :description="error"
    >
      <Button @click="page.reload">Tentar novamente</Button>
    </ErrorState>
    <template v-else>
      <FeaturePanel title="Filtros">
        <form class="feature-form" @submit.prevent="applyFilters">
          <label class="feature-field">
            Impressora
            <select v-model="filters.printerId">
              <option value="">Todas</option>
              <option
                v-for="printer in printers"
                :key="printer.assignmentId"
                :value="printer.assignmentId"
              >
                {{ printer.printerKey }}
              </option>
            </select>
          </label>
          <label class="feature-field">
            Bobina
            <select v-model="filters.spoolId">
              <option value="">Todas</option>
              <option
                v-for="spool in spools"
                :key="spool.id"
                :value="String(spool.id)"
              >
                {{ spoolText(spool.id) }}
              </option>
            </select>
          </label>
          <label class="feature-field">
            Trabalho (ID)
            <input
              v-model="filters.jobId"
              type="text"
              inputmode="numeric"
              placeholder="Ex.: 42"
            />
          </label>
          <label class="feature-field">
            Agrupar resumo
            <select v-model="groupBy">
              <option
                v-for="option in GROUP_BY_OPTIONS"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }}
              </option>
            </select>
          </label>
          <Button type="submit">Aplicar</Button>
        </form>
      </FeaturePanel>

      <FeaturePanel
        title="Resumo de consumo e custo"
        description="Custo = preço da bobina (ou do filamento) ÷ peso inicial × gramas usadas."
      >
        <EmptyState
          v-if="!report || !report.rows.length"
          title="Sem consumo registrado"
          description="Nenhum consumo corresponde aos filtros escolhidos."
        />
        <FeatureTable
          v-else
          :caption="`Resumo ${GROUP_BY_OPTIONS.find((o) => o.value === groupBy)?.label.toLowerCase() ?? ''}`"
          :columns="summaryColumns"
        >
          <tr v-for="(row, index) in report.rows" :key="index">
            <td>{{ groupLabel(row) }}</td>
            <td>{{ row.records }}</td>
            <td>{{ formatGrams(row.grams) }}</td>
            <td>{{ costText(row.cost, row.unpricedRecords) }}</td>
          </tr>
        </FeatureTable>
      </FeaturePanel>

      <FeaturePanel
        title="Registros de uso"
        description="Cada consumo debitado de uma bobina. Corrija um registro para ajustar o peso usado da bobina."
      >
        <div v-if="canWrite" class="feature-actions">
          <Button @click="manualOpen = true">Registrar consumo manual</Button>
        </div>
        <EmptyState
          v-if="!records.length"
          title="Nenhum registro de uso"
          description="O consumo aparece aqui quando um trabalho termina em uma impressora com bobina atribuída."
        />
        <FeatureTable
          v-else
          caption="Registros de uso de filamento"
          :columns="recordColumns"
        >
          <tr v-for="record in records" :key="record.id">
            <td>{{ formatStamp(record.createdAt) }}</td>
            <td>
              <SpoolIllustration
                :spool="spoolById.get(record.spoolId)"
                compact
              />
              {{ spoolText(record.spoolId) }}
            </td>
            <td>
              {{
                record.printerId
                  ? (printerKeyById.get(record.printerId) ?? record.printerId)
                  : '—'
              }}
            </td>
            <td>{{ record.jobId == null ? '—' : `#${record.jobId}` }}</td>
            <td>{{ formatGrams(record.grams) }}</td>
            <td>{{ formatMoney(record.cost, currency) }}</td>
            <td>
              {{ SOURCE_LABELS[record.source] ?? record.source }}
              <span v-if="record.correctedBy"> (corrigido)</span>
            </td>
            <td>
              <Button
                v-if="canWrite"
                :aria-label="`Corrigir consumo de ${formatGrams(record.grams)} da bobina #${record.spoolId}`"
                @click="openCorrect(record)"
              >
                Corrigir
              </Button>
            </td>
          </tr>
        </FeatureTable>
      </FeaturePanel>
    </template>

    <Dialog v-model="correctOpen" title="Corrigir consumo">
      <form class="dialog-form" @submit.prevent="submitCorrect">
        <label class="feature-field">
          Gramas usadas
          <input
            v-model="correctGrams"
            type="text"
            inputmode="decimal"
            :aria-invalid="correctError ? true : undefined"
          />
        </label>
        <p v-if="correctError" role="alert" class="error-line">
          {{ correctError }}
        </p>
        <Button type="submit" :disabled="busy">Salvar correção</Button>
      </form>
    </Dialog>

    <Dialog v-model="manualOpen" title="Registrar consumo manual">
      <form class="dialog-form" @submit.prevent="submitManual">
        <label class="feature-field">
          Bobina
          <select v-model="manual.spoolId">
            <option value="">Escolha…</option>
            <option
              v-for="spool in spools"
              :key="spool.id"
              :value="String(spool.id)"
            >
              {{ spoolText(spool.id) }}
            </option>
          </select>
        </label>
        <SpoolIllustration
          v-if="spoolById.has(Number(manual.spoolId))"
          :spool="spoolById.get(Number(manual.spoolId))"
          compact
        />
        <label class="feature-field">
          Gramas usadas
          <input v-model="manual.grams" type="text" inputmode="decimal" />
        </label>
        <label class="feature-field">
          Impressora (opcional)
          <select v-model="manual.printerId">
            <option value="">Nenhuma</option>
            <option
              v-for="printer in printers"
              :key="printer.assignmentId"
              :value="printer.assignmentId"
            >
              {{ printer.printerKey }}
            </option>
          </select>
        </label>
        <p v-if="manualError" role="alert" class="error-line">
          {{ manualError }}
        </p>
        <Button type="submit" :disabled="busy">Registrar</Button>
      </form>
    </Dialog>
  </SpoolLibraryShell>
</template>

<style scoped>
.error-line {
  margin: 0;
  color: var(--printer-error);
}
.feature-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.dialog-form {
  display: grid;
  gap: var(--space-3);
  margin-block: var(--space-3);
}
.feature-field {
  display: grid;
  gap: var(--space-1);
  font-weight: var(--font-weight-semibold);
  font-size: var(--font-size-sm);
}
.dialog-form input,
.dialog-form select {
  min-height: 2.75rem;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-text-muted);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text);
  font: inherit;
}
.dialog-form input:focus-visible,
.dialog-form select:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
</style>
