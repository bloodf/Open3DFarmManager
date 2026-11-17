<script setup lang="ts">
import { usePrinterSetup } from '../../utils/printer-setup-state.ts'
import { usePrinterSetupActions } from '../../utils/printer-setup-actions.ts'

const { pending, revokeTarget, revokeConfirmed } = usePrinterSetup()
const { cancelRevocation, revoke } = usePrinterSetupActions()
</script>

<template>
  <section v-if="revokeTarget" aria-labelledby="revoke-heading">
    <h2 id="revoke-heading">Confirmar revogação permanente</h2>
    <p>
      Chave: <span class="exact-key">{{ revokeTarget.printerKey }}</span>.
      Connector: {{ revokeTarget.agentId }}.
    </p>
    <label
      ><input v-model="revokeConfirmed" type="checkbox" :disabled="pending" />
      Conferi esta atribuição e quero revogá-la permanentemente.</label
    ><button
      type="button"
      :disabled="pending || !revokeConfirmed"
      @click="revoke"
    >
      Confirmar revogação</button
    ><button type="button" :disabled="pending" @click="cancelRevocation">
      Cancelar revogação
    </button>
  </section>
</template>

<style scoped src="./printer-setup.css"></style>
