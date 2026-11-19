<script setup lang="ts">
import { computed, ref } from 'vue'
import Button from '../ui/Button.vue'
import StatusBadge from '../ui/StatusBadge.vue'
import Tabs from '../ui/Tabs.vue'
import ExtrusionPanel from './ExtrusionPanel.vue'
import MacrosPanel from './MacrosPanel.vue'
import HeaterPanel from './HeaterPanel.vue'
import OutputsPanel from './OutputsPanel.vue'
import MotionPanel from './MotionPanel.vue'
import HistoryPanel from './HistoryPanel.vue'
import type { JobHistoryItem } from '../../utils/job-history-view.ts'
import type { PrinterHistoryJob, PrinterHistoryTotals } from './history-view.ts'
import type { JogAxis, MotionAvailabilityMap } from './motion-view.ts'
import {
  DEFAULT_UNSUPPORTED_REASON,
  detailTabs,
  type DetailCapability,
  type DetailTabId,
  type HeaterHistory,
  type HeaterReading,
} from '../../utils/printer-detail-view.ts'

const props = defineProps<{
  name: string
  stateLabel: string
  stateTone: 'idle' | 'printing' | 'paused' | 'error' | 'offline'
  connectorLabel: string
  /** True only with a current direct connection; otherwise the page is read-only. */
  live: boolean
  /** Age of the last known data, shown while not live. */
  lastKnownText?: string
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
  canEmergencyStop: boolean
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
}>()
const emit = defineEmits<{
  (e: 'set-temperature', heater: string, targetC: number, event: Event): void
  (
    e: 'extrude',
    tool: number,
    lengthMm: number,
    feed: number,
    event: Event,
  ): void
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
const tabs = computed(() => detailTabs(props.capabilities, props.reasons))
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
      <p v-if="!live" role="status">
        Sem conexão direta: exibindo o último valor conhecido<template
          v-if="lastKnownText"
          >, {{ lastKnownText }}</template
        >. Somente leitura.
      </p>
      <p>
        <Button
          class="printer-detail__stop"
          :disabled="!canEmergencyStop"
          aria-describedby="stop-help"
          @click="emit('emergency-stop', $event)"
          >Parada de emergência</Button
        >
      </p>
      <p id="stop-help">
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
      <template #painel>
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
        <section v-else aria-labelledby="heaters-title">
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
        <section v-else aria-labelledby="motion-title">
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
      <template
        v-for="tab in tabs.available.filter(({ id }) => id !== 'painel')"
        :key="tab.id"
        #[tab.id]
      >
        <HistoryPanel
          v-if="tab.id === 'historico' && jobHistory"
          v-bind="jobHistory"
        />
        <p v-else>Sem dados de {{ tab.label }} neste momento.</p>
      </template>
    </Tabs>
    <section v-if="tabs.unavailable.length" aria-labelledby="unavailable-title">
      <h2 id="unavailable-title">Recursos indisponíveis</h2>
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
