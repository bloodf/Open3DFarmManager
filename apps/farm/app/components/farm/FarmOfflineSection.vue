<script setup lang="ts">
import type { LastKnownState } from '../../composables/useLastKnownStates-core.ts'
import LastKnownStates from './LastKnownStates.vue'

defineProps<{
  states: readonly LastKnownState[]
  nowWallMs: number
}>()
</script>

<template>
  <section
    aria-labelledby="last-known-heading"
    aria-describedby="last-known-description"
  >
    <h2 id="last-known-heading">Última observação conhecida</h2>
    <p id="last-known-description">
      Sem conexão direta, estes são os últimos estados que o servidor observou.
      As informações são somente leitura e podem estar desatualizadas.
    </p>
    <ul class="last-known-list">
      <li v-for="state in states" :key="state.assignmentId">
        <LastKnownStates :state="state" :now-wall-ms="nowWallMs" />
      </li>
    </ul>
  </section>
</template>
