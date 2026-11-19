<script setup lang="ts">
defineProps<{
  farms: readonly { farmId: string }[]
  farmId: string
  farmAfter: string | null
  nextFarm: string | null
}>()

const emit = defineEmits<{
  change: [event: Event]
  firstPage: []
  nextPage: [after: string]
}>()
</script>

<template>
  <section aria-labelledby="farm-scope-heading">
    <h2 id="farm-scope-heading">Escolha da farm</h2>
    <label for="farm-scope">Farm atual</label>
    <select id="farm-scope" :value="farmId" @change="emit('change', $event)">
      <option value="">Selecione uma farm</option>
      <option v-for="farm in farms" :key="farm.farmId" :value="farm.farmId">
        {{ farm.farmId }}
      </option>
    </select>
    <p v-if="farmId" class="opaque">Farm atual: {{ farmId }}</p>
    <p v-if="!farms.length">
      {{
        farmAfter || nextFarm
          ? 'Nenhuma farm nesta página.'
          : 'Sua conta ainda não tem acesso a uma farm.'
      }}
    </p>
    <div class="actions">
      <button v-if="farmAfter" type="button" @click="emit('firstPage')">
        Primeira página de farms
      </button>
      <button v-if="nextFarm" type="button" @click="emit('nextPage', nextFarm)">
        Próximas farms
      </button>
    </div>
  </section>
</template>
