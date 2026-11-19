<script setup lang="ts">
import type { ExtendedControlAction } from '../../../../../packages/farm-protocol/src/control-actions.ts'
import CameraDisplay from '../CameraDisplay.vue'
import FarmExtendedControls from '../FarmExtendedControls.vue'
import FarmMacrosControls from '../FarmMacrosControls.vue'
import PrinterControls from '../PrinterControls.vue'
import {
  isKobraXAssignment,
  KOBRA_X_DEVICE_CAPABILITIES,
} from '../../utils/kobralink-onboarding.ts'
import type { FarmKeyState, FarmRow } from '../../utils/farm-view.ts'
import FarmLocalOrigin from './FarmLocalOrigin.vue'

defineProps<{
  row: FarmRow & {
    draft?: { value: string; confirmed: boolean; error: string }
  }
  keys: FarmKeyState
  controlEnabled: boolean
  commandInFlight: boolean
  now: { wall: number; mono: number }
  lastResult: string | undefined
  pauseAvailable: boolean
  pauseReason: string
  cameraStream: MediaStream | null
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
    :stream="cameraStream"
    :printer-name="row.assignment.printerKey"
  />
  <template
    v-if="
      row.assignment.status === 'active' &&
      row.assignment.connectorStatus !== 'revoked' &&
      !isKobraXAssignment(row.assignment)
    "
  >
    <FarmLocalOrigin
      :row="row"
      @setup="emit('setupOrigin', $event)"
      @save="emit('saveOrigin', $event)"
      @cancel="emit('cancelOrigin', $event)"
    />
  </template>
  <FarmMacrosControls
    v-if="!isKobraXAssignment(row.assignment)"
    :row="row"
    :keys="keys"
    :control-enabled="controlEnabled"
    :command-in-flight="commandInFlight"
    :now="now"
    @action="(action, args, event) => emit('action', action, args, event)"
  />
  <FarmExtendedControls
    v-if="!isKobraXAssignment(row.assignment)"
    :row="row"
    :keys="keys"
    :control-enabled="controlEnabled"
    :command-in-flight="commandInFlight"
    :now="now"
    :last-result="lastResult"
    @action="(action, args, event) => emit('action', action, args, event)"
  />
  <template v-if="!isKobraXAssignment(row.assignment)">
    <template v-if="row.observation?.state.controls !== undefined">
      <PrinterControls
        :row="row"
        :keys="keys"
        :control-enabled="controlEnabled"
        :command-in-flight="commandInFlight"
        :now="now"
        :last-result="lastResult"
        @action="(action, event) => emit('action', action, {}, event)"
      />
    </template>
    <template v-else>
      <p
        v-if="!pauseAvailable"
        :id="`pause-help-${row.assignment.assignmentId}`"
      >
        {{ pauseReason }}
      </p>
      <p v-else :id="`pause-help-${row.assignment.assignmentId}`">
        Abre uma confirmação. Nada é enviado antes de você confirmar.
      </p>
      <button
        type="button"
        :aria-disabled="!pauseAvailable"
        :aria-describedby="`pause-help-${row.assignment.assignmentId}`"
        @click="emit('pause', $event)"
      >
        Pausar impressão
      </button>
    </template>
  </template>
</template>
