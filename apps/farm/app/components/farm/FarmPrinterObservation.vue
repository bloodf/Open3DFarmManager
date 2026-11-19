<script setup lang="ts">
import FarmEnvironment from '../FarmEnvironment.vue'
import FarmMaterials from '../FarmMaterials.vue'
import { farmJobOutcome } from '../../utils/farm-job-outcome.ts'
import { farmJobView } from '../../utils/farm-job-view.ts'
import { observationAge, type FarmRow } from '../../utils/farm-view.ts'
import ActiveSpoolAssign from './ActiveSpoolAssign.vue'

defineProps<{
  row: FarmRow
  farmId: string
  now: { wall: number; mono: number }
}>()

function temperatureLabel(value: number | undefined): string {
  return value === undefined
    ? 'Indisponível'
    : `${value.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} °C`
}

const DEFAULT_SPOOL_SLOTS = [
  'external',
  'ams:0:0',
  'ams:0:1',
  'ams:0:2',
  'ams:0:3',
]

function moonrakerActiveSpool(row: FarmRow): boolean {
  const materials = row.observation?.state.materials ?? []
  return materials.some(
    (material) => material.slot === 'external' && material.active === true,
  )
}

function activeSpoolSlots(row: FarmRow): string[] {
  const fromMaterials = (row.observation?.state.materials ?? []).map(
    (material) => material.slot,
  )
  return fromMaterials.length ? fromMaterials : [...DEFAULT_SPOOL_SLOTS]
}

function receiptAge(row: FarmRow, liveNow: { wall: number; mono: number }) {
  if (!row.observation) return ''
  const seconds = observationAge(row.observation, liveNow).seconds
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
  <template v-if="row.observation">
    <p>
      {{ receiptAge(row, now) }}. Recebido neste navegador em
      {{ dateLabel(row.observation.received.wall) }}.
    </p>
    <p v-if="observationAge(row.observation, now).sourceConfirmed">
      Observado pelo Connector em
      {{ dateLabel(row.observation.state.observedAt) }}. Idade da observação
      estimada a partir do relógio do Connector.
    </p>
    <p v-else>Horário da observação não confirmado</p>
    <p v-if="observationAge(row.observation, now).stale">
      Dados desatualizados. A impressora pode ter mudado de estado.
    </p>
    <dl aria-label="Temperaturas observadas">
      <div>
        <dt>Bico</dt>
        <dd>
          {{ temperatureLabel(row.observation.state.toolTemperatureCelsius) }}
        </dd>
      </div>
      <div>
        <dt>Mesa</dt>
        <dd>
          {{ temperatureLabel(row.observation.state.bedTemperatureCelsius) }}
        </dd>
      </div>
    </dl>
    <FarmMaterials :materials="row.observation.state.materials" />
    <ActiveSpoolAssign
      :farm-id="farmId"
      :printer-key="row.assignment.printerKey"
      :slots="activeSpoolSlots(row)"
      :moonraker-managed="moonrakerActiveSpool(row)"
    />
    <FarmEnvironment
      :fans="row.observation.state.fans"
      :light="row.observation.state.light"
    />
    <div aria-live="polite" aria-atomic="true">
      <template v-if="farmJobOutcome(row.observation.state)">
        <p>
          {{ farmJobOutcome(row.observation.state)?.label }}
        </p>
        <dl aria-label="Último trabalho">
          <div v-if="farmJobOutcome(row.observation.state)?.filename">
            <dt>Arquivo</dt>
            <dd class="opaque">
              {{ farmJobOutcome(row.observation.state)?.filename }}
            </dd>
          </div>
          <div>
            <dt>Fim</dt>
            <dd>
              {{ farmJobOutcome(row.observation.state)?.endedAt }}
            </dd>
          </div>
          <div v-if="farmJobOutcome(row.observation.state)?.duration">
            <dt>Duração</dt>
            <dd>
              {{ farmJobOutcome(row.observation.state)?.duration }}
            </dd>
          </div>
        </dl>
      </template>
    </div>
    <dl aria-label="Trabalho atual">
      <div v-if="farmJobView(row.observation.state).filename">
        <dt>Arquivo</dt>
        <dd>
          {{ farmJobView(row.observation.state).filename }}
        </dd>
      </div>
      <div v-if="farmJobView(row.observation.state).layer">
        <dt>Camada</dt>
        <dd>{{ farmJobView(row.observation.state).layer }}</dd>
      </div>
      <div v-if="farmJobView(row.observation.state).elapsed">
        <dt>Tempo decorrido</dt>
        <dd>
          {{ farmJobView(row.observation.state).elapsed }}
        </dd>
      </div>
      <div v-if="farmJobView(row.observation.state).remaining">
        <dt>Tempo restante estimado</dt>
        <dd>
          {{ farmJobView(row.observation.state).remaining }}
        </dd>
      </div>
    </dl>
    <p
      v-if="
        (row.observation.state.state === 'printing' ||
          row.observation.state.state === 'paused') &&
        row.observation.state.progress !== undefined
      "
    >
      <progress
        :value="row.observation.state.progress"
        :max="1"
        :aria-labelledby="`progress-${row.assignment.assignmentId}`"
      />
      <span :id="`progress-${row.assignment.assignmentId}`"
        >Progresso informado da impressão:
        {{ Math.round(row.observation.state.progress * 100) }}%</span
      >
    </p>
  </template>
</template>
