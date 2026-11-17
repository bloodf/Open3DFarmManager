<script setup lang="ts">
import { describeRecoveryReason } from '../../utils/kobralink-onboarding.ts'
import { usePrinterSetup } from '../../utils/printer-setup-state.ts'
import { usePrinterSetupActions } from '../../utils/printer-setup-actions.ts'

const {
  kobraBusy,
  kobraStage,
  kobraUnknownNotice,
  kobraRecoveryReason,
  kobraOperation,
  kobraConfirmed,
} = usePrinterSetup()
const { cancelKobraX, reconcileKobraX, resetKobraForm } =
  usePrinterSetupActions()
</script>

<template>
  <section
    v-if="kobraStage === 'awaiting-reconcile' && kobraOperation"
    aria-labelledby="kobra-reconcile-heading"
    class="kobra-card"
  >
    <h3 id="kobra-reconcile-heading">
      Estado da operação não confirmado — reconciliação segura
    </h3>
    <p>
      Operação:
      <span class="exact-key">{{ kobraOperation.operationId }}</span>.
      {{ kobraUnknownNotice }}
    </p>
    <p>
      Para evitar duplicação na ponte local, não envie um novo cadastro enquanto
      esta operação estiver pendente. Consulte o estado durável no Connector
      para retomar ou concluir a confirmação do recibo.
    </p>
    <div class="kobra-actions">
      <button type="button" :disabled="kobraBusy" @click="reconcileKobraX">
        {{
          kobraBusy
            ? 'Consultando Connector…'
            : 'Consultar e reconciliar operação'
        }}
      </button>
      <button type="button" :disabled="kobraBusy" @click="cancelKobraX">
        Solicitar cancelamento no Connector
      </button>
    </div>
  </section>

  <section
    v-if="kobraStage === 'recovery-required' && kobraOperation"
    aria-labelledby="kobra-recovery-heading"
    class="kobra-card"
  >
    <h3 id="kobra-recovery-heading">Recuperação pendente no Connector</h3>
    <p>
      Operação:
      <span class="exact-key">{{ kobraOperation.operationId }}</span>. Motivo:
      {{ describeRecoveryReason(kobraRecoveryReason) }}
    </p>
    <p>
      A ativação automática desta impressora foi bloqueada para proteger as
      impressoras já confirmadas. O encerramento abaixo libera a fila de
      configuração no Connector, mas não confirma a remoção de registros
      ambíguos na ponte local.
    </p>
    <div class="kobra-actions">
      <button type="button" :disabled="kobraBusy" @click="reconcileKobraX">
        Consultar estado da operação
      </button>
      <button type="button" :disabled="kobraBusy" @click="cancelKobraX">
        Encerrar operação pendente no Connector
      </button>
    </div>
  </section>

  <section
    v-if="kobraStage === 'confirmed' && kobraConfirmed"
    aria-labelledby="kobra-confirmed-heading"
    class="kobra-card"
  >
    <h3 id="kobra-confirmed-heading">
      Impressora confirmada e ativa em modo somente leitura
    </h3>
    <dl>
      <dt>Chave canônica atribuída</dt>
      <dd class="exact-key">{{ kobraConfirmed.printerKey }}</dd>
      <dt>ID da atribuição</dt>
      <dd class="exact-key">{{ kobraConfirmed.assignmentId }}</dd>
      <dt>Identidade verificada (device_id)</dt>
      <dd class="exact-key">
        {{ kobraConfirmed.receipt.observed.device_id }}
      </dd>
      <dt>Fase do recibo assinado</dt>
      <dd>{{ kobraConfirmed.receipt.phase }}</dd>
      <dt>Revisão confirmada no Connector</dt>
      <dd>{{ kobraConfirmed.committedRevision }}</dd>
    </dl>
    <div class="kobra-actions">
      <button type="button" @click="resetKobraForm">
        Adicionar outra impressora
      </button>
    </div>
  </section>
</template>

<style scoped src="./printer-setup.css"></style>
