<script setup lang="ts">
// Keys stored in this browser for the current account and farm, with the
// registration state of each one. Presentation only: the page owns requests.
import Button from '../ui/Button.vue'
import EmptyState from '../ui/EmptyState.vue'
import type { BrowserDeviceHttpListResponse } from '../../../../../packages/farm-protocol/src/browser-device-http.ts'
import type { LocalDeviceKey } from '../../utils/device-key'
import OnboardingPanel from './OnboardingPanel.vue'

type Device = BrowserDeviceHttpListResponse['devices'][number]

const props = defineProps<{
  accountId: string
  keys: readonly LocalDeviceKey[]
  devices: readonly Device[]
  busy: boolean
}>()
const emit = defineEmits<{
  create: []
  enroll: [key: LocalDeviceKey, purpose: 'enroll' | 'recover']
}>()

const maxKeys = 32
const stateText = {
  pending: 'pendente de aprovação',
  approved: 'aprovado',
  revoked: 'revogado',
} as const

function registration(key: LocalDeviceKey) {
  return props.devices.find(
    (device) =>
      device.thumbprint === key.thumbprint &&
      device.accountId === props.accountId,
  )
}
</script>

<template>
  <OnboardingPanel
    heading-id="keys-heading"
    title="Chaves deste navegador"
    :busy="busy"
  >
    <p>
      Conta atual: <code>{{ accountId }}</code>. Criar outra chave não substitui
      nem revoga as anteriores.
    </p>
    <div class="actions">
      <Button
        :disabled="busy || keys.length >= maxKeys"
        @click="emit('create')"
      >
        Criar chave e solicitar cadastro
      </Button>
    </div>
    <p v-if="keys.length >= maxKeys" class="limit">
      Este navegador já tem {{ maxKeys }} chaves para esta conta e farm. Não é
      possível criar outra.
    </p>
    <EmptyState
      v-if="!keys.length"
      :level="3"
      title="Sem chaves neste navegador"
      description="Nenhuma chave local para esta conta e farm. Se você perdeu o armazenamento, crie uma nova chave e solicite nova aprovação."
    />
    <ul v-else class="keys" aria-label="Chaves locais">
      <li v-for="key in keys" :key="key.thumbprint">
        <p class="print">
          Impressão digital: <code>{{ key.thumbprint }}</code>
        </p>
        <p v-if="registration(key)" class="state">
          Registro nesta farm: {{ stateText[registration(key)!.status] }}.
        </p>
        <p v-else class="hint">
          O registro desta chave não aparece nesta página. Consulte outras
          páginas ou escolha explicitamente a operação adequada. O servidor
          verifica o estado atual.
        </p>
        <div class="actions">
          <Button
            v-if="!registration(key) || registration(key)?.proofAt === null"
            :disabled="busy || registration(key)?.status === 'revoked'"
            @click="emit('enroll', key, 'enroll')"
          >
            Retomar cadastro com esta chave
          </Button>
          <Button
            v-if="!registration(key) || registration(key)?.proofAt !== null"
            :disabled="busy || registration(key)?.status === 'revoked'"
            @click="emit('enroll', key, 'recover')"
          >
            Confirmar posse da chave existente
          </Button>
        </div>
      </li>
    </ul>
  </OnboardingPanel>
</template>

<style scoped>
code {
  overflow-wrap: anywhere;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
}
.keys {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
}
li {
  display: grid;
  gap: var(--space-2);
  padding-block: var(--space-4);
  border-block-end: 1px solid var(--color-border);
  min-width: 0;
}
li:first-child {
  padding-block-start: 0;
}
li:last-child {
  padding-block-end: 0;
  border-block-end: 0;
}
.hint,
.limit {
  color: var(--color-text-muted);
}
@media (max-width: 30rem) {
  .actions :deep(.ui-button) {
    width: 100%;
  }
}
</style>
