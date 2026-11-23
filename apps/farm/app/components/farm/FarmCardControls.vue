<script setup lang="ts">
import FarmMacrosControls from '../FarmMacrosControls.vue'
import FarmExtendedControls from '../FarmExtendedControls.vue'
import PrinterControls from '../PrinterControls.vue'
import CollectionHold from './CollectionHold.vue'
import { type FarmRow, type FarmKeyState } from '../../utils/farm-view.ts'
import { isKobraXAssignment } from '../../utils/kobralink-onboarding.ts'
import { type ExtendedControlAction } from '../../../../../packages/farm-protocol/src/control-actions.ts'
defineProps<{
  row: FarmRow
  showCollection?: boolean
  keys: FarmKeyState
  controlEnabled: boolean
  commandInFlight: boolean
  liveNow: () => { wall: number; mono: number }
  lastResult?: string
  availability: (row: FarmRow) => { available: boolean; reason?: string }
  openControl: (
    row: FarmRow,
    action: ExtendedControlAction,
    event: Event,
    args?: Record<string, unknown>,
  ) => Promise<void>
}>()
</script>

<template>
  <CollectionHold
    v-if="showCollection !== false && !isKobraXAssignment(row.assignment)"
    :row="row"
    :keys="keys"
    :control-enabled="controlEnabled"
    :command-in-flight="commandInFlight"
    :open-control="openControl"
  />
  <FarmMacrosControls
    v-if="!isKobraXAssignment(row.assignment)"
    :row="row"
    :keys="keys"
    :control-enabled="controlEnabled"
    :command-in-flight="commandInFlight"
    :now="liveNow()"
    @action="(action, args, event) => openControl(row, action, event, args)"
  />
  <FarmExtendedControls
    v-if="!isKobraXAssignment(row.assignment)"
    :row="row"
    :keys="keys"
    :control-enabled="controlEnabled"
    :command-in-flight="commandInFlight"
    :now="liveNow()"
    :last-result="lastResult"
    @action="(action, args, event) => openControl(row, action, event, args)"
  />
  <template v-if="!isKobraXAssignment(row.assignment)">
    <template v-if="row.observation?.state.controls !== undefined">
      <PrinterControls
        :row="row"
        :keys="keys"
        :control-enabled="controlEnabled"
        :command-in-flight="commandInFlight"
        :now="liveNow()"
        :last-result="lastResult"
        @action="(action, event) => openControl(row, action, event)"
      />
    </template>
    <template v-else>
      <p
        v-if="!availability(row).available"
        :id="`pause-help-${row.assignment.assignmentId}`"
      >
        {{ availability(row).reason }}
      </p>
      <p v-else :id="`pause-help-${row.assignment.assignmentId}`">
        Abre uma confirmação. Nada é enviado antes de você confirmar.
      </p>
      <button
        type="button"
        :aria-disabled="!availability(row).available"
        :aria-describedby="`pause-help-${row.assignment.assignmentId}`"
        @click="openControl(row, 'pause', $event)"
      >
        Pausar impressão
      </button>
    </template>
  </template>
</template>

<style scoped src="./farm-view.css"></style>
