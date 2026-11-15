<script setup lang="ts">
import { computed } from 'vue'
import type { ControlAction } from '../../../../packages/farm-protocol/src/control-actions.ts'
import type { FarmKeyState, FarmRow } from '../utils/farm-view.ts'
import { getPrinterActionButtons, type Clock } from '../utils/farm-control.ts'

const props = defineProps<{
  row: FarmRow
  keys: FarmKeyState
  controlEnabled: boolean
  commandInFlight: boolean
  now: Clock
  lastResult?: string | null
}>()

const emit = defineEmits<{
  (e: 'action', action: ControlAction, event: Event): void
}>()

// The tick keeps this reactive; the fresh sample keeps a frame received after
// the last tick from having a negative age and disabling every button.
function liveNow(): Clock {
  void props.now
  return { wall: Date.now(), mono: performance.now() }
}
const buttons = computed(() =>
  getPrinterActionButtons(
    props.row,
    props.keys,
    props.controlEnabled,
    props.commandInFlight,
    liveNow(),
  ),
)

function onActionClick(action: ControlAction, event: Event) {
  emit('action', action, event)
}
</script>

<template>
  <div
    v-if="buttons.length > 0"
    class="printer-controls"
    role="group"
    :aria-label="'Controles da impressora ' + row.assignment.printerKey"
  >
    <p
      v-if="lastResult"
      role="status"
      aria-live="polite"
      class="control-result"
    >
      {{ lastResult }}
    </p>
    <div class="actions">
      <template v-for="btn in buttons" :key="btn.action">
        <p
          v-if="!btn.available && btn.reason"
          :id="`control-help-${row.assignment.assignmentId}-${btn.action}`"
          class="control-help"
        >
          {{ btn.reason }}
        </p>
        <button
          type="button"
          :aria-disabled="btn.disabled"
          :aria-describedby="
            !btn.available && btn.reason
              ? `control-help-${row.assignment.assignmentId}-${btn.action}`
              : undefined
          "
          @click="onActionClick(btn.action, $event)"
        >
          {{ btn.label }}
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.printer-controls {
  margin-top: 0.75rem;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1rem;
  align-items: center;
}
.control-help {
  width: 100%;
  margin: 0.25rem 0 0;
  font-size: 0.9em;
}
.control-result {
  margin: 0 0 0.5rem;
  font-weight: 500;
}
button {
  font: inherit;
  min-height: 2.75rem;
  padding: 0.6rem;
  max-width: 100%;
  cursor: pointer;
}
button:disabled,
button[aria-disabled='true'] {
  cursor: not-allowed;
}
:is(button):focus-visible {
  outline: 3px solid currentColor;
  outline-offset: 3px;
}
</style>
