<script setup lang="ts">
import { computed } from 'vue'
import type { FarmRow, FarmKeyState } from '../../utils/farm-view.ts'
import { liveControlActionAvailability } from '../../utils/farm-control.ts'
import type { ExtendedControlAction } from '../../../../../packages/farm-protocol/src/control-actions.ts'
import {
  COLLECTION_ACTION_LABEL,
  NATIVE_QUEUE_WARNING,
  collectionHoldView,
} from './collection-hold-view.ts'
const props = defineProps<{
  row: FarmRow
  keys: FarmKeyState
  controlEnabled: boolean
  commandInFlight: boolean
  openControl: (
    row: FarmRow,
    action: ExtendedControlAction,
    event: Event,
    args?: Record<string, unknown>,
  ) => Promise<void>
}>()
const view = computed(() => collectionHoldView(props.row))
const availability = computed(() =>
  view.value.awaiting
    ? liveControlActionAvailability(
        'confirm_collection',
        props.row,
        props.keys,
        props.controlEnabled,
      )
    : { available: false, reason: '' },
)
const helpId = computed(
  () => `collection-help-${props.row.assignment.assignmentId}`,
)
function confirm(event: Event) {
  const attempt = view.value.attempt
  if (!attempt) return
  void props.openControl(props.row, 'confirm_collection', event, { attempt })
}
</script>

<template>
  <div v-if="view.awaiting || view.nativeQueueWarning" class="collection-hold">
    <template v-if="view.awaiting">
      <p :id="helpId" role="status">{{ view.status }}</p>
      <p v-if="!availability.available && availability.reason">
        {{ availability.reason }}
      </p>
      <button
        type="button"
        :aria-describedby="helpId"
        :disabled="commandInFlight || !availability.available || !view.attempt"
        @click="confirm"
      >
        {{ COLLECTION_ACTION_LABEL }}
      </button>
    </template>
    <p v-if="view.nativeQueueWarning" class="native-queue-warning">
      <strong>Atenção:</strong> {{ NATIVE_QUEUE_WARNING }}
    </p>
  </div>
</template>

<style scoped>
.collection-hold {
  display: grid;
  gap: var(--space-2);
}
.collection-hold p {
  margin: 0;
}
.native-queue-warning {
  color: var(--color-text-muted);
}
</style>
