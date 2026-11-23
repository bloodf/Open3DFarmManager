<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import Button from '../../components/ui/Button.vue'
import EmptyState from '../../components/ui/EmptyState.vue'
import ErrorState from '../../components/ui/ErrorState.vue'
import Skeleton from '../../components/ui/Skeleton.vue'
import FeaturePanel from '../../components/spool-library/FeaturePanel.vue'
import SpoolLibraryShell from '../../components/spool-library/SpoolLibraryShell.vue'
import {
  featureFetch,
  fetchPrinters,
  fetchSpools,
  useSpoolFeaturePage,
} from '../../composables/useSpoolFeaturePage.ts'
import {
  activeAssignments,
  formatGrams,
  formatStamp,
  SLOT_KIND_LABELS,
  slotLabel,
} from '../../utils/spool-features-format.ts'
import type {
  PrinterRef,
  SlotAssignment,
  SlotKind,
} from '../../utils/spool-features-types.ts'
import { spoolDisplayTitle } from '../../utils/spool-library-format.ts'
import type { SpoolItem } from '../../utils/spool-library-types.ts'

const printers = ref<PrinterRef[]>([])
const spools = ref<SpoolItem[]>([])
const assignments = ref<SlotAssignment[]>([])
const canWrite = ref(false)
const busy = ref(false)
const drafts = reactive<
  Record<string, { kind: SlotKind; index: string; spoolId: string }>
>({})

async function load(farmId: string) {
  const [printerList, spoolList, slotList] = await Promise.all([
    fetchPrinters(farmId),
    fetchSpools(farmId),
    featureFetch<{ assignments: SlotAssignment[] }>(farmId, 'slots'),
  ])
  printers.value = printerList
  spools.value = spoolList.items.filter((spool) => !spool.archived)
  canWrite.value = spoolList.canWrite
  assignments.value = slotList.assignments
  for (const printer of printerList)
    drafts[printer.assignmentId] ??= { kind: 'ams', index: '1', spoolId: '' }
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

const active = computed(() => activeAssignments(assignments.value))
const spoolById = computed(
  () => new Map(spools.value.map((spool) => [Number(spool.id), spool])),
)

function spoolText(id: number): string {
  const spool = spoolById.value.get(Number(id))
  return spool ? `#${id} · ${spoolDisplayTitle(spool)}` : `#${id}`
}

function assignmentsOf(printerId: string) {
  return active.value.filter((item) => item.printerId === printerId)
}

async function assign(printer: PrinterRef) {
  const draft = drafts[printer.assignmentId]
  const slotIndex = Number(draft?.index)
  const spoolId = Number(draft?.spoolId)
  if (
    !draft ||
    busy.value ||
    !Number.isInteger(slotIndex) ||
    slotIndex < 1 ||
    slotIndex > 1025 ||
    !Number.isSafeInteger(spoolId) ||
    spoolId < 1
  ) {
    actionError.value =
      'Escolha uma bobina e informe o número do slot (a partir de 1).'
    return
  }
  busy.value = true
  const ok = await page.act(
    async () => {
      await featureFetch(farmId.value, 'slots', {
        method: 'POST',
        body: {
          spoolId,
          printerId: printer.assignmentId,
          slotKind: draft.kind,
          slotIndex: slotIndex - 1,
        },
      })
      await load(farmId.value)
    },
    `Bobina #${spoolId} atribuída a ${printer.printerKey} (${slotLabel(draft.kind, slotIndex - 1)}).`,
    'Não foi possível atribuir a bobina ao slot.',
  )
  busy.value = false
  if (ok) draft.spoolId = ''
}

async function unassign(item: SlotAssignment, printer: PrinterRef) {
  if (busy.value) return
  busy.value = true
  await page.act(
    async () => {
      await featureFetch(farmId.value, 'slots/unassign', {
        method: 'POST',
        body: {
          printerId: item.printerId,
          slotKind: item.slotKind,
          slotIndex: item.slotIndex,
        },
      })
      await load(farmId.value)
    },
    `Bobina #${item.spoolId} removida de ${printer.printerKey} (${slotLabel(item.slotKind, item.slotIndex)}).`,
    'Não foi possível remover a bobina do slot.',
  )
  busy.value = false
}
</script>

<template>
  <SpoolLibraryShell
    section="slots"
    title="Slots das impressoras"
    description="Atribua bobinas a impressoras, slots de AMS ou cabeçotes. O consumo dos trabalhos é registrado na bobina do slot ativo."
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
    <p v-if="actionError" role="alert" class="error-line">{{ actionError }}</p>

    <div v-if="loading" aria-busy="true">
      <p role="status">Carregando slots…</p>
      <Skeleton />
    </div>
    <ErrorState
      v-else-if="error"
      title="Não foi possível carregar os slots"
      :description="error"
    >
      <Button @click="page.reload">Tentar novamente</Button>
    </ErrorState>
    <EmptyState
      v-else-if="!printers.length"
      title="Nenhuma impressora cadastrada"
      description="Cadastre uma impressora na farm para atribuir bobinas aos slots dela."
    />
    <template v-else>
      <p v-if="!canWrite" role="status" class="muted">
        Modo somente leitura. Operadores, administradores e proprietários podem
        atribuir bobinas.
      </p>
      <FeaturePanel
        v-for="printer in printers"
        :key="printer.assignmentId"
        :title="`Impressora ${printer.printerKey}`"
        description="Uma bobina ocupa um slot por vez: atribuir a outro slot move a bobina."
      >
        <ul
          v-if="assignmentsOf(printer.assignmentId).length"
          class="slot-list"
          :aria-label="`Slots ativos de ${printer.printerKey}`"
        >
          <li
            v-for="item in assignmentsOf(printer.assignmentId)"
            :key="item.id"
          >
            <div>
              <strong>{{ slotLabel(item.slotKind, item.slotIndex) }}</strong>
              <span class="muted"> · {{ spoolText(item.spoolId) }}</span>
              <span class="muted">
                · desde {{ formatStamp(item.assignedAt) }}
                <template v-if="spoolById.get(Number(item.spoolId))">
                  · restante
                  {{
                    formatGrams(
                      spoolById.get(Number(item.spoolId))?.remaining_weight,
                    )
                  }}
                </template>
              </span>
            </div>
            <Button
              v-if="canWrite"
              :disabled="busy"
              :aria-label="`Remover bobina #${item.spoolId} de ${printer.printerKey}, ${slotLabel(item.slotKind, item.slotIndex)}`"
              @click="unassign(item, printer)"
            >
              Remover
            </Button>
          </li>
        </ul>
        <p v-else class="muted">Nenhuma bobina atribuída a esta impressora.</p>

        <form
          v-if="canWrite && drafts[printer.assignmentId]"
          class="feature-form"
          :aria-label="`Atribuir bobina a ${printer.printerKey}`"
          @submit.prevent="assign(printer)"
        >
          <label class="feature-field">
            Tipo de slot
            <select v-model="drafts[printer.assignmentId]!.kind">
              <option
                v-for="(label, kind) in SLOT_KIND_LABELS"
                :key="kind"
                :value="kind"
              >
                {{ label }}
              </option>
            </select>
          </label>
          <label class="feature-field">
            Número do slot
            <input
              v-model="drafts[printer.assignmentId]!.index"
              type="number"
              min="1"
              max="1025"
              step="1"
              inputmode="numeric"
            />
          </label>
          <label class="feature-field">
            Bobina
            <select v-model="drafts[printer.assignmentId]!.spoolId">
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
          <Button type="submit" :disabled="busy">Atribuir</Button>
        </form>
      </FeaturePanel>
    </template>
  </SpoolLibraryShell>
</template>

<style scoped>
.slot-list {
  display: grid;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}
.slot-list li {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  overflow-wrap: anywhere;
}
.muted {
  color: var(--color-text-muted);
  margin: 0;
}
.error-line {
  margin: 0;
  color: var(--printer-error);
}
</style>
