<script setup lang="ts">
import { type FarmViewState } from '../../utils/farm-view.ts'
defineProps<{ ready: Extract<FarmViewState, { kind: 'ready' }> }>()
const emit = defineEmits<{
  select: [farmId: string]
  discover: [after?: string]
}>()
function chooseFarm(event: Event) {
  if (event.target instanceof HTMLSelectElement)
    emit('select', event.target.value)
}
</script>

<template>
  <section aria-labelledby="farm-scope-heading">
    <h2 id="farm-scope-heading">Escolha da farm</h2>
    <label for="farm-scope">Farm atual</label>
    <select
      id="farm-scope"
      :value="ready.scope?.farmId ?? ''"
      @change="chooseFarm"
    >
      <option value="">Selecione uma farm</option>
      <option
        v-for="farm in ready.farms"
        :key="farm.farmId"
        :value="farm.farmId"
      >
        {{ farm.farmId }}
      </option>
    </select>
    <p v-if="ready.scope" class="opaque">
      Farm atual: {{ ready.scope.farmId }}
    </p>
    <p v-if="!ready.farms.length">
      {{
        ready.farmAfter || ready.nextFarm
          ? 'Nenhuma farm nesta página.'
          : 'Sua conta ainda não tem acesso a uma farm.'
      }}
    </p>
    <div class="actions">
      <button v-if="ready.farmAfter" type="button" @click="emit('discover')">
        Primeira página de farms
      </button>
      <button
        v-if="ready.nextFarm"
        type="button"
        @click="emit('discover', ready.nextFarm)"
      >
        Próximas farms
      </button>
    </div>
  </section>
</template>

<style scoped src="./farm-view.css"></style>
