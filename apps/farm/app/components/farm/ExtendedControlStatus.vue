<script setup lang="ts">
import { computed } from 'vue'
import { extendedControlStatusText } from '../../utils/farm-control.ts'
import type { FarmPauseControlState } from '../../utils/webrtc/farm-pause-control.ts'
const props = defineProps<{
  state: FarmPauseControlState
  remaining: number
  lost: boolean
}>()
const status = computed(() =>
  props.lost &&
  (props.state.kind === 'failed' || props.state.kind === 'connecting')
    ? 'O estado da impressora deixou de estar ao vivo. Nenhum comando foi enviado.'
    : extendedControlStatusText(props.state, props.remaining),
)
</script>
<template>
  <p role="status" aria-live="polite">{{ status }}</p>
</template>
