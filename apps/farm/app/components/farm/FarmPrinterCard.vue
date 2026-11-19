<script setup lang="ts">
import type { ExtendedControlAction } from '../../../../../packages/farm-protocol/src/control-actions.ts'
import {
  formatPrinterStateLabel,
  type FarmKeyState,
  type FarmRow,
} from '../../utils/farm-view.ts'
import FarmPrinterCardControls from './FarmPrinterCardControls.vue'
import FarmPrinterObservation from './FarmPrinterObservation.vue'

defineProps<{
  row: FarmRow & {
    draft?: { value: string; confirmed: boolean; error: string }
  }
  farmId: string
  keys: FarmKeyState
  controlEnabled: boolean
  commandInFlight: boolean
  now: { wall: number; mono: number }
  lastResult: string | undefined
  pauseAvailable: boolean
  pauseReason: string
  cameraStream: MediaStream | null
  connectionText: string
}>()

const emit = defineEmits<{
  action: [
    action: ExtendedControlAction,
    args: Record<string, unknown>,
    event: Event,
  ]
  pause: [event: Event]
  setupOrigin: [assignmentId: string]
  saveOrigin: [assignmentId: string]
  cancelOrigin: [assignmentId: string]
}>()
</script>

<template>
  <article :aria-labelledby="`printer-${row.assignment.assignmentId}`">
    <h3 :id="`printer-${row.assignment.assignmentId}`" class="opaque">
      {{ row.assignment.printerKey }}
    </h3>
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
      <dd>{{ connectionText }}</dd>
      <dt>Último estado informado</dt>
      <dd>
        {{
          row.observation
            ? formatPrinterStateLabel(row.observation.state)
            : 'Nenhum estado recebido'
        }}
      </dd>
    </dl>
    <FarmPrinterObservation :row="row" :farm-id="farmId" :now="now" />
    <FarmPrinterCardControls
      :row="row"
      :keys="keys"
      :control-enabled="controlEnabled"
      :command-in-flight="commandInFlight"
      :now="now"
      :last-result="lastResult"
      :pause-available="pauseAvailable"
      :pause-reason="pauseReason"
      :camera-stream="cameraStream"
      @action="(action, args, event) => emit('action', action, args, event)"
      @pause="emit('pause', $event)"
      @setup-origin="emit('setupOrigin', $event)"
      @save-origin="emit('saveOrigin', $event)"
      @cancel-origin="emit('cancelOrigin', $event)"
    />
  </article>
</template>
