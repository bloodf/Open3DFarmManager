<script setup lang="ts">
import ProgressRing from '../ui/charts/ProgressRing.vue'
import { formatDateTime, formatTemperature } from '../../utils/ui-format.ts'
import { computed } from 'vue'
import type { SlotBinding } from '../../utils/farm-slot-view.ts'
import FarmMaterials from '../FarmMaterials.vue'
import FarmEnvironment from '../FarmEnvironment.vue'
import CameraDisplay from '../CameraDisplay.vue'
import ActiveSpoolAssign from './ActiveSpoolAssign.vue'
import FarmLocalInterface from './FarmLocalInterface.vue'
import PrinterAlerts from './PrinterAlerts.vue'
import {
  formatPrinterStateLabel,
  observationAge,
  type FarmRow,
} from '../../utils/farm-view.ts'
import { deriveRowAlerts, type FarmAlert } from '../../utils/farm-alerts.ts'
import { farmJobOutcome } from '../../utils/farm-job-outcome.ts'
import { farmJobView } from '../../utils/farm-job-view.ts'
import {
  KOBRA_X_DEVICE_CAPABILITIES,
  isKobraXAssignment,
} from '../../utils/kobralink-onboarding.ts'
const props = defineProps<{
  row: FarmRow & {
    draft?: { value: string; confirmed: boolean; error: string }
  }
  farmId: string
  bindings?: Readonly<Record<string, SlotBinding | undefined>>
  cameraFor: (id: string) => MediaStream | null
  liveNow: () => { wall: number; mono: number }
  alerts?: readonly FarmAlert[]
}>()
const liveNow = props.liveNow
const cardAlerts = computed(
  () => props.alerts ?? deriveRowAlerts(props.row, props.liveNow()),
)
const emit = defineEmits<{ setup: []; save: []; cancel: [] }>()
function temperatureLabel(value: number | undefined): string {
  return formatTemperature(value) ?? 'Indisponível'
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
  const seconds = observationAge(row.observation, liveNow()).seconds
  return seconds === null
    ? 'Horário de recebimento não confirmado'
    : seconds >= 86_400
      ? 'Atualização recebida há mais de 24 h'
      : `Atualização recebida há ${seconds} s`
}
function dateLabel(time: number) {
  return time <= 8_640_000_000_000_000
    ? (formatDateTime(time) ?? 'Horário não confirmado')
    : 'Horário não confirmado'
}
</script>

<template>
  <li class="printer-card">
    <article :aria-labelledby="`printer-${row.assignment.assignmentId}`">
      <h3 :id="`printer-${row.assignment.assignmentId}`" class="opaque">
        {{ row.assignment.printerKey }}
      </h3>
      <slot name="summary" />
      <PrinterAlerts
        v-if="cardAlerts.length && !$slots.summary"
        :chips="cardAlerts"
        label="Alertas da impressora"
      />
      <a
        :href="`/impressoras/${encodeURIComponent(row.assignment.printerKey)}?farm=${encodeURIComponent(farmId)}`"
        >Abrir detalhes da impressora
        <span class="opaque">{{ row.assignment.printerKey }}</span></a
      >
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
              ? formatPrinterStateLabel(row.observation.state)
              : 'Nenhum estado recebido'
          }}
        </dd>
      </dl>
      <template v-if="row.observation">
        <p>
          {{ receiptAge(row) }}. Recebido neste navegador em
          {{ dateLabel(row.observation.received.wall) }}.
        </p>
        <p v-if="observationAge(row.observation, liveNow()).sourceConfirmed">
          {{
            row.observation.state.preformStatus
              ? 'Consultado no PreForm em'
              : 'Observado pelo Connector em'
          }}
          {{ dateLabel(row.observation.state.observedAt) }}. Idade da observação
          estimada a partir do relógio do Connector.
        </p>
        <p v-else>Horário da observação não confirmado</p>
        <p v-if="observationAge(row.observation, liveNow()).stale">
          Dados desatualizados. A impressora pode ter mudado de estado.
        </p>
        <dl aria-label="Temperaturas observadas">
          <div>
            <dt>Bico</dt>
            <dd>
              {{
                temperatureLabel(row.observation.state.toolTemperatureCelsius)
              }}
            </dd>
          </div>
          <div>
            <dt>Mesa</dt>
            <dd>
              {{
                temperatureLabel(row.observation.state.bedTemperatureCelsius)
              }}
            </dd>
          </div>
        </dl>
        <FarmMaterials
          v-if="!row.observation.historical"
          :materials="row.observation.state.materials"
          :bindings="bindings"
        />
        <p
          v-else-if="row.observation.state.materials?.length"
          class="farm-card-stale"
        >
          Materiais indisponíveis: os dados estão desatualizados.
        </p>
        <p
          v-if="
            row.connection !== 'authenticated' ||
            observationAge(row.observation, liveNow()).stale
          "
        >
          A atribuição de bobina está indisponível sem dados atuais e conexão
          direta.
        </p>
        <ActiveSpoolAssign
          v-if="farmId && !row.observation.historical"
          :farm-id="farmId"
          :printer-key="row.assignment.printerKey"
          :slots="activeSpoolSlots(row)"
          :busy="
            row.connection !== 'authenticated' ||
            observationAge(row.observation, liveNow()).stale
          "
          :moonraker-managed="moonrakerActiveSpool(row)"
          :materials="row.observation.state.materials"
          :bindings="bindings"
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
        <div
          v-if="
            (row.observation.state.state === 'printing' ||
              row.observation.state.state === 'paused') &&
            row.observation.state.progress !== undefined
          "
        >
          <ProgressRing
            label="Progresso informado da impressão"
            :value="row.observation.state.progress * 100"
          />
        </div>
      </template>
      <section
        v-if="isKobraXAssignment(row.assignment)"
        :aria-labelledby="'capabilities-' + row.assignment.assignmentId"
      >
        <h4 :id="'capabilities-' + row.assignment.assignmentId">
          Capacidades admitidas deste dispositivo (Anycubic Kobra X)
        </h4>
        <p>
          Qualificação provisória de modelo; firmware não qualificado. Comandos
          remotos não estão disponíveis.
        </p>
        <dl>
          <div v-for="cap in KOBRA_X_DEVICE_CAPABILITIES" :key="cap.id">
            <dt>{{ cap.label }}</dt>
            <dd>{{ cap.statusText }} — {{ cap.reason }}</dd>
          </div>
        </dl>
      </section>
      <CameraDisplay
        v-if="
          row.assignment.status === 'active' &&
          row.assignment.connectorStatus === 'approved' &&
          !isKobraXAssignment(row.assignment)
        "
        :stream="cameraFor(row.assignment.assignmentId)"
        :printer-name="row.assignment.printerKey"
      />
      <FarmLocalInterface
        :row="row"
        @setup="emit('setup')"
        @save="emit('save')"
        @cancel="emit('cancel')"
        ><slot name="local-link" :row="row"
      /></FarmLocalInterface>
      <slot />
    </article>
  </li>
</template>

<style scoped src="./farm-view.css"></style>
