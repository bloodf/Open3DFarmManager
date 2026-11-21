<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import Button from '../../components/ui/Button.vue'
import EmptyState from '../../components/ui/EmptyState.vue'
import ErrorState from '../../components/ui/ErrorState.vue'
import Skeleton from '../../components/ui/Skeleton.vue'
import FeaturePanel from '../../components/spool-library/FeaturePanel.vue'
import FeatureTable from '../../components/spool-library/FeatureTable.vue'
import SpoolLibraryShell from '../../components/spool-library/SpoolLibraryShell.vue'
import {
  featureFetch,
  fetchSpools,
  useSpoolFeaturePage,
} from '../../composables/useSpoolFeaturePage.ts'
import {
  formatStamp,
  localInputToMs,
  msToLocalInput,
  parseAmount,
  validateDrying,
} from '../../utils/spool-features-format.ts'
import type {
  DryingLog,
  HumidityReading,
} from '../../utils/spool-features-types.ts'
import { spoolDisplayTitle } from '../../utils/spool-library-format.ts'
import type { SpoolItem } from '../../utils/spool-library-types.ts'

const spools = ref<SpoolItem[]>([])
const canWrite = ref(false)
const spoolId = ref('')
const logs = ref<DryingLog[]>([])
const readings = ref<HumidityReading[]>([])
const busy = ref(false)
const dryingErrors = ref<Record<string, string>>({})
const humidityError = ref('')
const drying = reactive({
  startedAt: '',
  endedAt: '',
  temperature: '55',
  notes: '',
})
const humidity = reactive({ percent: '', recordedAt: '' })

async function loadSpoolData(farmId: string) {
  const id = Number(spoolId.value)
  if (!Number.isSafeInteger(id) || id < 1) {
    logs.value = []
    readings.value = []
    return
  }
  const [dryingList, humidityList] = await Promise.all([
    featureFetch<DryingLog[]>(farmId, 'drying', { query: { spoolId: id } }),
    featureFetch<HumidityReading[]>(farmId, 'humidity', {
      query: { spoolId: id },
    }),
  ])
  logs.value = dryingList
  readings.value = humidityList
}

async function load(farmId: string) {
  const list = await fetchSpools(farmId)
  spools.value = list.items.filter((spool) => !spool.archived)
  canWrite.value = list.canWrite
  const now = msToLocalInput(Date.now())
  drying.startedAt ||= now
  humidity.recordedAt ||= now
  if (!spools.value.some((spool) => String(spool.id) === spoolId.value))
    spoolId.value = ''
  await loadSpoolData(farmId)
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

const selected = computed(() =>
  spools.value.find((spool) => String(spool.id) === spoolId.value),
)
const dryingColumns = [
  { id: 'start', label: 'Início' },
  { id: 'end', label: 'Fim' },
  { id: 'temp', label: 'Temperatura' },
  { id: 'notes', label: 'Observações' },
  { id: 'action', label: 'Ações' },
]
const humidityColumns = [
  { id: 'when', label: 'Medido em' },
  { id: 'percent', label: 'Umidade' },
  { id: 'source', label: 'Origem' },
]
const chronological = computed(() =>
  [...readings.value].sort((a, b) => a.recordedAt - b.recordedAt),
)

const chart = computed(() => {
  const points = chronological.value
  if (points.length < 2) return null
  const first = points[0]!.recordedAt
  const span = Math.max(points[points.length - 1]!.recordedAt - first, 1)
  const coords = points.map((p) => {
    const x = 8 + ((p.recordedAt - first) / span) * 284
    const y = 8 + (1 - p.humidityPercent / 100) * 84
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  return coords.join(' ')
})

async function changeSpool() {
  if (!farmId.value) return
  await page.act(
    () => loadSpoolData(farmId.value),
    'Histórico atualizado.',
    'Não foi possível carregar o histórico da bobina.',
  )
}

async function startDrying() {
  const result = validateDrying({ ...drying, spoolId: spoolId.value })
  if (!result.ok) {
    dryingErrors.value = result.errors
    return
  }
  dryingErrors.value = {}
  if (busy.value) return
  busy.value = true
  const body = result.body
  await page.act(
    async () => {
      await featureFetch(farmId.value, 'drying', { method: 'POST', body })
      await loadSpoolData(farmId.value)
    },
    `Secagem registrada na bobina #${body.spoolId}.`,
    'Não foi possível registrar a secagem.',
  )
  busy.value = false
}

async function endDrying(log: DryingLog) {
  if (busy.value) return
  busy.value = true
  await page.act(
    async () => {
      await featureFetch(farmId.value, 'drying/end', {
        method: 'POST',
        body: { id: log.id, endedAt: Math.max(Date.now(), log.startedAt) },
      })
      await loadSpoolData(farmId.value)
    },
    'Secagem encerrada.',
    'Não foi possível encerrar a secagem.',
  )
  busy.value = false
}

async function logHumidity() {
  const id = Number(spoolId.value)
  const percent = parseAmount(humidity.percent, { max: 100 })
  const recordedAt = localInputToMs(humidity.recordedAt)
  if (!Number.isSafeInteger(id) || id < 1) {
    humidityError.value = 'Escolha uma bobina.'
    return
  }
  if (!percent.ok) {
    humidityError.value = percent.error
    return
  }
  if (recordedAt === null) {
    humidityError.value = 'Informe quando a leitura foi feita.'
    return
  }
  humidityError.value = ''
  if (busy.value) return
  busy.value = true
  const ok = await page.act(
    async () => {
      await featureFetch(farmId.value, 'humidity', {
        method: 'POST',
        body: {
          spoolId: id,
          humidityPercent: percent.value,
          recordedAt,
          source: 'manual',
        },
      })
      await loadSpoolData(farmId.value)
    },
    `Umidade de ${percent.value}% registrada na bobina #${id}.`,
    'Não foi possível registrar a umidade.',
  )
  busy.value = false
  if (ok) humidity.percent = ''
}
</script>

<template>
  <SpoolLibraryShell
    section="drying"
    title="Secagem e umidade"
    description="Registre sessões de secagem e leituras de umidade das bobinas e consulte o histórico."
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
      <p role="status">Carregando bobinas…</p>
      <Skeleton />
    </div>
    <ErrorState
      v-else-if="error"
      title="Não foi possível carregar os dados"
      :description="error"
    >
      <Button @click="page.reload">Tentar novamente</Button>
    </ErrorState>
    <EmptyState
      v-else-if="!spools.length"
      title="Nenhuma bobina ativa"
      description="Cadastre uma bobina para registrar secagem e umidade."
    />
    <template v-else>
      <FeaturePanel title="Bobina">
        <label class="feature-field">
          Escolha a bobina
          <select v-model="spoolId" @change="changeSpool">
            <option value="">Escolha…</option>
            <option
              v-for="spool in spools"
              :key="spool.id"
              :value="String(spool.id)"
            >
              #{{ spool.id }} · {{ spoolDisplayTitle(spool) }}
            </option>
          </select>
        </label>
      </FeaturePanel>

      <template v-if="selected">
        <FeaturePanel
          title="Sessões de secagem"
          :description="`Histórico de secagem da bobina #${selected.id}.`"
        >
          <form
            v-if="canWrite"
            class="feature-form"
            aria-label="Registrar secagem"
            @submit.prevent="startDrying"
          >
            <label class="feature-field">
              Início
              <input v-model="drying.startedAt" type="datetime-local" />
              <span v-if="dryingErrors.startedAt" class="error-line">
                {{ dryingErrors.startedAt }}
              </span>
            </label>
            <label class="feature-field">
              Fim (opcional)
              <input v-model="drying.endedAt" type="datetime-local" />
              <span v-if="dryingErrors.endedAt" class="error-line">
                {{ dryingErrors.endedAt }}
              </span>
            </label>
            <label class="feature-field">
              Temperatura (°C)
              <input
                v-model="drying.temperature"
                type="text"
                inputmode="decimal"
              />
              <span v-if="dryingErrors.temperature" class="error-line">
                {{ dryingErrors.temperature }}
              </span>
            </label>
            <label class="feature-field">
              Observações
              <input v-model="drying.notes" type="text" maxlength="1024" />
            </label>
            <Button type="submit" :disabled="busy">Registrar secagem</Button>
          </form>
          <p v-if="dryingErrors.spoolId" role="alert" class="error-line">
            {{ dryingErrors.spoolId }}
          </p>
          <EmptyState
            v-if="!logs.length"
            title="Nenhuma secagem registrada"
            description="Registre uma sessão para acompanhar quando a bobina foi seca."
          />
          <FeatureTable
            v-else
            :caption="`Secagens da bobina #${selected.id}`"
            :columns="dryingColumns"
          >
            <tr v-for="log in logs" :key="log.id">
              <td>{{ formatStamp(log.startedAt) }}</td>
              <td>
                {{
                  log.endedAt === null
                    ? 'Em andamento'
                    : formatStamp(log.endedAt)
                }}
              </td>
              <td>{{ log.temperatureCelsius }} °C</td>
              <td>{{ log.notes || '—' }}</td>
              <td>
                <Button
                  v-if="canWrite && log.endedAt === null"
                  :disabled="busy"
                  :aria-label="`Encerrar secagem iniciada em ${formatStamp(log.startedAt)}`"
                  @click="endDrying(log)"
                >
                  Encerrar
                </Button>
              </td>
            </tr>
          </FeatureTable>
        </FeaturePanel>

        <FeaturePanel
          title="Histórico de umidade"
          :description="`Leituras de umidade da bobina #${selected.id}.`"
        >
          <form
            v-if="canWrite"
            class="feature-form"
            aria-label="Registrar umidade"
            @submit.prevent="logHumidity"
          >
            <label class="feature-field">
              Umidade (%)
              <input
                v-model="humidity.percent"
                type="text"
                inputmode="decimal"
              />
            </label>
            <label class="feature-field">
              Medido em
              <input v-model="humidity.recordedAt" type="datetime-local" />
            </label>
            <Button type="submit" :disabled="busy">Registrar umidade</Button>
          </form>
          <p v-if="humidityError" role="alert" class="error-line">
            {{ humidityError }}
          </p>
          <EmptyState
            v-if="!readings.length"
            title="Nenhuma leitura de umidade"
            description="Registre uma leitura para começar o histórico."
          />
          <template v-else>
            <svg
              v-if="chart"
              class="humidity-chart"
              viewBox="0 0 300 100"
              role="img"
              :aria-label="`Gráfico de umidade da bobina #${selected.id}: ${readings.length} leituras, de ${chronological[0]?.humidityPercent}% a ${chronological[chronological.length - 1]?.humidityPercent}%`"
            >
              <rect
                x="0"
                y="0"
                width="300"
                height="100"
                fill="none"
                stroke="currentColor"
                stroke-opacity="0.3"
              />
              <polyline
                :points="chart"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              />
            </svg>
            <FeatureTable
              :caption="`Leituras de umidade da bobina #${selected.id}`"
              :columns="humidityColumns"
            >
              <tr v-for="reading in readings" :key="reading.id">
                <td>{{ formatStamp(reading.recordedAt) }}</td>
                <td>{{ reading.humidityPercent }}%</td>
                <td>{{ reading.source === 'ams' ? 'AMS' : 'Manual' }}</td>
              </tr>
            </FeatureTable>
          </template>
        </FeaturePanel>
      </template>
      <p v-else class="feature-muted" role="status">
        Escolha uma bobina para ver e registrar secagem e umidade.
      </p>
    </template>
  </SpoolLibraryShell>
</template>

<style scoped>
.error-line {
  margin: 0;
  color: var(--printer-error);
}
.feature-muted {
  margin: 0;
  color: var(--color-text-muted);
}
.humidity-chart {
  inline-size: 100%;
  max-inline-size: 32rem;
  block-size: auto;
  color: var(--color-accent);
}
</style>
