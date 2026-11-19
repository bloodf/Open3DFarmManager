<script setup lang="ts">
import { usePrinterSetupActions } from '../../utils/printer-setup-actions.ts'
import { usePrinterSetup } from '../../utils/printer-setup-state.ts'

const { farms, farmId, nextFarm, pending } = usePrinterSetup()
const { selectFarm, loadFarms } = usePrinterSetupActions()
</script>

<template>
  <label for="printer-farm">Farm</label
  ><select
    id="printer-farm"
    v-model="farmId"
    :disabled="pending"
    @change="selectFarm"
  >
    <option value="">Selecione uma farm</option>
    <option v-for="farm in farms" :key="farm.farmId" :value="farm.farmId">
      {{ farm.farmId }}
    </option>
  </select>
  <button
    v-if="nextFarm"
    type="button"
    :disabled="pending"
    @click="loadFarms(nextFarm)"
  >
    Próximas farms
  </button>
</template>
