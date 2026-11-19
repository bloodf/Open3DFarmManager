<script setup lang="ts">
import { computed, ref } from 'vue'
import Button from '../ui/Button.vue'
import StatusBadge from '../ui/StatusBadge.vue'
import Tabs from '../ui/Tabs.vue'
import ExtrusionPanel from './ExtrusionPanel.vue'
import HeaterPanel from './HeaterPanel.vue'
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
  canEmergencyStop: boolean
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
  (e: 'emergency-stop', event: Event): void
}>()

const selected = ref<DetailTabId>('painel')
const tabs = computed(() => detailTabs(props.capabilities, props.reasons))
const hasHeaters = computed(() => props.capabilities?.includes('heaters'))
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
      </template>
      <template
        v-for="tab in tabs.available.filter(({ id }) => id !== 'painel')"
        :key="tab.id"
        #[tab.id]
      >
        <p>Sem dados de {{ tab.label }} neste momento.</p>
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
