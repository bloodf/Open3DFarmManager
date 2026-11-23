<script setup lang="ts">
import { computed, ref } from 'vue'
import Button from '../ui/Button.vue'
import StaleNotice from '../ui/StaleNotice.vue'
import StatusBadge from '../ui/StatusBadge.vue'
import Tabs from '../ui/Tabs.vue'
import ExtrusionPanel from './ExtrusionPanel.vue'
import MacrosPanel from './MacrosPanel.vue'
import HeaterPanel from './HeaterPanel.vue'
import PrintStatusPanel from './PrintStatusPanel.vue'
import type { z } from 'zod'
import type { PrinterDetailStreamUpdate } from '../../../../../packages/farm-protocol/src/printer-detail.ts'
import JobQueuePanel, { type QueueJob } from './JobQueuePanel.vue'
import OutputsPanel from './OutputsPanel.vue'
import BedMeshPanel from './BedMeshPanel.vue'
import type {
  BedMeshData,
  MeshAvailabilityMap,
  MeshOp,
} from './heightmap-view.ts'
import MotionPanel from './MotionPanel.vue'
import HistoryPanel from './HistoryPanel.vue'
import TimelapsePanel from './TimelapsePanel.vue'
import type { JobHistoryItem } from '../../utils/job-history-view.ts'
import type { PrinterHistoryJob, PrinterHistoryTotals } from './history-view.ts'
import ConsolePanel from './ConsolePanel.vue'
import type { JogAxis, MotionAvailabilityMap } from './motion-view.ts'
import type {
  QueueOpArguments,
  TimelapseArguments,
} from '../../../../../packages/farm-protocol/src/control-actions.ts'
import {
  DEFAULT_UNSUPPORTED_REASON,
  detailTabs,
  type DetailCapability,
  type VendorPanelCatalog,
  type DetailTabId,
  type HeaterHistory,
  type HeaterReading,
} from '../../utils/printer-detail-view.ts'

const props = defineProps<{
  bedMesh?: { mesh?: BedMeshData; availability: MeshAvailabilityMap }
  name: string
  stateLabel: string
  stateTone: 'idle' | 'printing' | 'paused' | 'error' | 'offline' | 'stale'
  connectorLabel: string
  /** True only with a current direct connection; otherwise the page is read-only. */
  live: boolean
  /** Age of the last known data, shown while not live. */
  lastKnownText?: string
  supportedOnly?: boolean
  vendorCatalog?: VendorPanelCatalog
  capabilities?: readonly DetailCapability[]
  /** Catalog reasons per capability the printer does not advertise. */
  reasons?: Readonly<Partial<Record<DetailCapability, string>>>
  heaters: readonly HeaterReading[]
  history: HeaterHistory
  canCommand: boolean
  commandReason?: string
  /** Extrusion control: shown with its reason when not advertised. */
  extrusion?: {
    advertised: boolean
    tools: readonly number[]
    canCommand: boolean
    reason?: string
  }
  /** Macro control: shown with its reason when not advertised. */
  macros?: {
    advertised: boolean
    list: readonly {
      name: string
      params: readonly { name: string; default?: string }[]
    }[]
    canCommand: boolean
    reason?: string
  }
  /** Named fans, LEDs and pins: shown with the reason when not advertised. */
  outputs?: {
    advertised: { fan: boolean; led: boolean; pin: boolean }
    canCommand: boolean
    reason?: string
  }
  /** Job queue control and the queue the detail session reported. */
  queue?: {
    advertised: boolean
    state?: string
    jobs?: readonly QueueJob[]
    canCommand: boolean
    reason?: string
  }
  /** G-code console tab; the Connector enforces role, state and rate. */
  gcodeConsole?: {
    advertised: boolean
    canCommand: boolean
    reason?: string
    printerKey: string
    printing?: boolean
    commands?: readonly string[]
    responses?: readonly { seq: number; lines: readonly string[] }[]
  }
  canEmergencyStop: boolean
  /** Timelapse: the panel shows the catalog reason when not advertised. */
  timelapse?: {
    advertised: boolean
    files?: readonly string[]
    rendering?: boolean
    canCommand: boolean
    canTransfer?: boolean
    reason?: string
    transferReason?: string
  }
  /** Per-printer history: the panel shows with the catalog reason when not advertised. */
  jobHistory?: {
    advertised: boolean
    disabledReason?: string
    jobs: readonly PrinterHistoryJob[]
    totals: PrinterHistoryTotals | null
    openfarmJobs: readonly JobHistoryItem[]
    pending?: boolean
    error?: string
    replayHref?: (librarySha256: string) => string | undefined
  }
  /** Motion controls; the panel shows only when the printer advertises motion. */
  motionAvailability?: MotionAvailabilityMap
  position?: readonly number[]
  homedAxes?: readonly string[]
  speedPct?: number
  flowPct?: number
  printStatus?: z.infer<typeof PrinterDetailStreamUpdate> | undefined
  excludeAvailable?: boolean
  excludeReason?: string | undefined
}>()
const emit = defineEmits<{
  (e: 'bed-mesh', args: { op: MeshOp; profile?: string }, event: Event): void
  (e: 'set-temperature', heater: string, targetC: number, event: Event): void
  (
    e: 'extrude',
    tool: number,
    lengthMm: number,
    feed: number,
    event: Event,
  ): void
  (e: 'exclude-object', name: string, event: Event): void
  (
    e: 'run-macro',
    name: string,
    params: Record<string, string> | undefined,
    event: Event,
  ): void
  (e: 'set-fan', fan: string, percent: number, event: Event): void
  (
    e: 'set-led',
    name: string,
    channels: { r: number; g: number; b: number; w?: number },
    event: Event,
  ): void
  (e: 'set-pin', name: string, value: number, event: Event): void
  (e: 'queue-op', args: QueueOpArguments, event: Event): void
  (e: 'timelapse-op', args: TimelapseArguments, event: Event): void
  (
    e: 'timelapse-transfer',
    kind: 'play' | 'download',
    file: string,
    event: Event,
  ): void
  (e: 'send-gcode', line: string, event: Event): void
  (e: 'emergency-stop', event: Event): void
  (e: 'home', event: Event): void
  (
    e: 'jog',
    axis: JogAxis,
    distanceMm: number,
    feed: number,
    event: Event,
  ): void
  (e: 'motors-off', event: Event): void
  (e: 'z-babystep', deltaMm: number, event: Event): void
  (e: 'set-factor', speedPct: number, flowPct: number, event: Event): void
}>()

const selected = ref<DetailTabId>('painel')
const tabs = computed(() =>
  detailTabs(props.capabilities, props.reasons, props.vendorCatalog),
)
const hasHeaters = computed(() => props.capabilities?.includes('heaters'))
const hasMotion = computed(() => props.capabilities?.includes('motion'))
const hasFactors = computed(
  () =>
    !!props.capabilities?.includes('speed') &&
    !!props.capabilities.includes('flow'),
)
const motionReason = computed(
  () => props.reasons?.motion ?? DEFAULT_UNSUPPORTED_REASON,
)
const factorsReason = computed(
  () =>
    props.reasons?.speed ?? props.reasons?.flow ?? DEFAULT_UNSUPPORTED_REASON,
)
const heaterReason = computed(
  () => props.reasons?.heaters ?? DEFAULT_UNSUPPORTED_REASON,
)
</script>

<template>
  <div class="printer-detail">
    <header class="printer-detail__header">
      <h1 tabindex="-1">{{ name }}</h1>
      <p class="printer-detail__status">
        <StatusBadge :tone="live ? stateTone : 'stale'" :label="stateLabel" />
        <span>Connector: {{ connectorLabel }}</span>
      </p>
      <StaleNotice
        v-if="!live"
        :description="`Sem conexão direta: exibindo o último valor conhecido${lastKnownText ? `, ${lastKnownText}` : ''}. Somente leitura.`"
      />
      <p v-if="!supportedOnly || canEmergencyStop">
        <Button
          class="printer-detail__stop"
          :disabled="!canEmergencyStop"
          aria-describedby="stop-help"
          @click="emit('emergency-stop', $event)"
          >Parada de emergência</Button
        >
      </p>
      <p v-if="!supportedOnly || canEmergencyStop" id="stop-help">
        {{
          canEmergencyStop
            ? 'Abre uma confirmação. Nada é enviado antes de você confirmar.'
            : 'Indisponível sem conexão direta atual e autorizada.'
        }}
      </p>
    </header>
    <Tabs
      v-model="selected"
      label="Seções da impressora"
      :tabs="tabs.available"
    >
      <template #sistema><slot name="sistema" /></template>
      <template #painel>
        <PrintStatusPanel
          v-if="printStatus?.capabilities.includes('job')"
          :frame="printStatus"
          :can-exclude="!!excludeAvailable"
          :exclude-reason="excludeReason"
          :object-reason="reasons?.['exclude-object']"
          @exclude="(name, event) => emit('exclude-object', name, event)"
        />
        <HeaterPanel
          v-if="hasHeaters"
          :heaters="heaters"
          :history="history"
          :can-command="canCommand"
          :disabled-reason="commandReason"
          @set-temperature="
            (heater, target, event) =>
              emit('set-temperature', heater, target, event)
          "
        />
        <section v-else-if="!supportedOnly" aria-labelledby="heaters-title">
          <h2 id="heaters-title">Aquecedores</h2>
          <p>{{ heaterReason }}</p>
        </section>
        <MotionPanel
          v-if="hasMotion"
          :availability="motionAvailability ?? {}"
          :position="position"
          :homed-axes="homedAxes"
          :speed-pct="speedPct"
          :flow-pct="flowPct"
          :factors="hasFactors"
          :factors-reason="factorsReason"
          @home="(event) => emit('home', event)"
          @jog="
            (axis, distance, feed, event) =>
              emit('jog', axis, distance, feed, event)
          "
          @motors-off="(event) => emit('motors-off', event)"
          @z-babystep="(delta, event) => emit('z-babystep', delta, event)"
          @set-factor="
            (speed, flow, event) => emit('set-factor', speed, flow, event)
          "
        />
        <section v-else-if="!supportedOnly" aria-labelledby="motion-title">
          <h2 id="motion-title">Movimento</h2>
          <p>{{ motionReason }}</p>
        </section>
        <ExtrusionPanel
          v-if="extrusion"
          :advertised="extrusion.advertised"
          :tools="extrusion.tools"
          :can-command="extrusion.canCommand"
          :disabled-reason="extrusion.reason"
          @extrude="
            (tool, lengthMm, feed, event) =>
              emit('extrude', tool, lengthMm, feed, event)
          "
        />
        <MacrosPanel
          v-if="macros"
          :advertised="macros.advertised"
          :macros="macros.list"
          :can-command="macros.canCommand"
          :disabled-reason="macros.reason"
          @run-macro="
            (name, params, event) => emit('run-macro', name, params, event)
          "
        />
        <slot name="painel" />
        <OutputsPanel
          v-if="outputs"
          :advertised="outputs.advertised"
          :can-command="outputs.canCommand"
          :disabled-reason="outputs.reason"
          @set-fan="
            (fan, percent, event) => emit('set-fan', fan, percent, event)
          "
          @set-led="
            (name, channels, event) => emit('set-led', name, channels, event)
          "
          @set-pin="(name, value, event) => emit('set-pin', name, value, event)"
        />
      </template>
      <template v-if="gcodeConsole" #console>
        <ConsolePanel
          :advertised="gcodeConsole.advertised"
          :can-command="gcodeConsole.canCommand"
          :disabled-reason="gcodeConsole.reason"
          :printer-key="gcodeConsole.printerKey"
          :printing="gcodeConsole.printing"
          :commands="gcodeConsole.commands"
          :responses="gcodeConsole.responses"
          @send-line="(line, event) => emit('send-gcode', line, event)"
        />
      </template>
      <template
        v-for="tab in tabs.available.filter(
          ({ id }) =>
            id !== 'painel' &&
            id !== 'sistema' &&
            !(id === 'console' && gcodeConsole),
        )"
        :key="tab.id"
        #[tab.id]
      >
        <BedMeshPanel
          v-if="tab.id === 'malha'"
          :mesh="bedMesh?.mesh"
          :availability="bedMesh?.availability ?? {}"
          @bed-mesh="(args, event) => emit('bed-mesh', args, event)"
        />
        <JobQueuePanel
          v-else-if="tab.id === 'fila' && queue"
          :advertised="queue.advertised"
          :state="queue.state"
          :jobs="queue.jobs"
          :can-command="queue.canCommand"
          :disabled-reason="queue.reason"
          @queue-op="(args, event) => emit('queue-op', args, event)"
        />
        <TimelapsePanel
          v-else-if="tab.id === 'timelapse' && timelapse"
          :advertised="timelapse.advertised"
          :files="timelapse.files"
          :rendering="timelapse.rendering"
          :can-command="timelapse.canCommand"
          :can-transfer="timelapse.canTransfer"
          :disabled-reason="timelapse.reason"
          :transfer-reason="timelapse.transferReason"
          @render="(event) => emit('timelapse-op', { op: 'render' }, event)"
          @delete="
            (file, event) => emit('timelapse-op', { op: 'delete', file }, event)
          "
          @play="
            (file, event) => emit('timelapse-transfer', 'play', file, event)
          "
          @download="
            (file, event) => emit('timelapse-transfer', 'download', file, event)
          "
        />
        <HistoryPanel
          v-else-if="tab.id === 'historico' && jobHistory"
          v-bind="jobHistory"
        />
        <slot v-else :name="tab.id"
          ><p>Sem dados de {{ tab.label }} neste momento.</p></slot
        >
      </template>
    </Tabs>
    <section v-if="tabs.unavailable.length" aria-labelledby="unavailable-title">
      <h2 id="unavailable-title">Recursos indisponíveis</h2>
      <p v-if="vendorCatalog">{{ vendorCatalog.hardwareNote }}</p>
      <ul>
        <li v-for="tab in tabs.unavailable" :key="tab.id">
          <strong>{{ tab.label }}:</strong> {{ tab.reason }}
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.printer-detail {
  min-width: 0;
  overflow-wrap: anywhere;
}
.printer-detail :deep(dd),
.printer-detail :deep(output),
.printer-detail :deep(progress) {
  font-family: var(--ops-font-mono);
  font-variant-numeric: tabular-nums;
}
.printer-detail__status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-4);
}
.printer-detail__stop {
  font-weight: bold;
  border-width: 3px;
}
</style>
