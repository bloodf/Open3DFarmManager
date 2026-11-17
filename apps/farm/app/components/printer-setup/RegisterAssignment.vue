<script setup lang="ts">
import { usePrinterSetup } from '../../utils/printer-setup-state.ts'
import { usePrinterSetupActions } from '../../utils/printer-setup-actions.ts'

const {
  farmId,
  connectors,
  nextConnector,
  canManage,
  pending,
  agentId,
  printerKey,
  confirmed,
} = usePrinterSetup()
const { register, run, loadConnectors } = usePrinterSetupActions()
</script>

<template>
  <section v-if="farmId && canManage" aria-labelledby="register-heading">
    <h2 id="register-heading">Cadastrar atribuição</h2>
    <p id="configuration-help">
      Confira a configuração local do Connector e copie a chave exata. Sua
      confirmação é uma declaração administrativa. O servidor não descobre
      impressoras nem verifica a configuração local. Não informe endereço de
      rede ou G-code.
    </p>
    <form @submit.prevent="register">
      <fieldset :disabled="pending">
        <legend>Configuração confirmada localmente</legend>
        <label for="printer-agent">Connector aprovado</label
        ><select id="printer-agent" v-model="agentId" required>
          <option value="">Selecione um Connector aprovado</option>
          <option
            v-for="connector in connectors"
            :key="connector.agentId"
            :value="connector.agentId"
          >
            {{ connector.agentId }} · {{ connector.fingerprint }}
          </option></select
        ><button
          v-if="nextConnector"
          type="button"
          @click="
            run((signal, current) =>
              loadConnectors(signal, current, nextConnector),
            )
          "
        >
          Próximos Connectors
        </button>
        <p v-if="!connectors.length">Nenhum Connector aprovado nesta página.</p>
        <label for="printer-key">Chave exata da impressora</label
        ><input
          id="printer-key"
          v-model="printerKey"
          required
          maxlength="128"
          autocomplete="off"
          aria-describedby="configuration-help key-help"
        />
        <p id="key-help">
          De 1 a 128 unidades UTF-16, sem alterar espaços, maiúsculas ou
          acentos.
        </p>
        <label
          ><input v-model="confirmed" type="checkbox" required /> Conferi que
          esta chave exata está configurada localmente neste Connector.</label
        ><button
          type="submit"
          :disabled="!confirmed || !agentId || !printerKey"
        >
          Cadastrar atribuição
        </button>
      </fieldset>
    </form>
    <p>
      Revogar é permanente. Para reatribuir uma chave, revogue a atribuição
      atual e cadastre uma nova. O novo cadastro pode falhar; nenhuma atribuição
      anterior será restaurada.
    </p>
  </section>
</template>

<style scoped src="./printer-setup.css"></style>
