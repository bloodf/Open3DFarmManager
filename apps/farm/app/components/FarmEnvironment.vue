<script setup lang="ts">
import { computed } from 'vue'
import type { PrinterState } from '../../../../packages/farm-protocol/src/state.ts'
import { farmEnvironmentView } from '../utils/farm-environment-view.ts'

const props = defineProps<{
  fans?: PrinterState['fans']
  light?: PrinterState['light']
}>()

const environment = computed(() => farmEnvironmentView(props.fans, props.light))
</script>

<template>
  <dl
    v-if="environment !== undefined"
    class="farm-environment"
    aria-label="Ventilação e iluminação"
  >
    <div v-for="fan in environment.fans" :key="fan.id">
      <dt>
        <span class="environment-icon" aria-hidden="true">💨</span>
        <span>{{ fan.label }}</span>
      </dt>
      <dd>{{ fan.percentLabel }}</dd>
    </div>
    <div v-if="environment.light">
      <dt>
        <span class="environment-icon" aria-hidden="true">💡</span>
        <span>{{ environment.light.label }}</span>
      </dt>
      <dd>{{ environment.light.statusLabel }}</dd>
    </div>
  </dl>
</template>

<style scoped>
.farm-environment {
  margin: 0.5rem 0;
}
.environment-icon {
  margin-right: 0.25rem;
}
dt {
  font-weight: 600;
  margin-top: 0.75rem;
}
dd {
  margin: 0.25rem 0 0;
}
</style>
