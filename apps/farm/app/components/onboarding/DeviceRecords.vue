<script setup lang="ts">
// Registrations of the farm, with the approve/revoke controls owners and
// administrators get after typing the full fingerprint. Presentation only.
import Button from '../ui/Button.vue'
import EmptyState from '../ui/EmptyState.vue'
import StatusBadge from '../ui/StatusBadge.vue'
import type { BrowserDeviceHttpListResponse } from '../../../../../packages/farm-protocol/src/browser-device-http.ts'
import { formatDateTime } from '../../utils/ui-format.ts'
import OnboardingField from './OnboardingField.vue'
import OnboardingPanel from './OnboardingPanel.vue'

type Device = BrowserDeviceHttpListResponse['devices'][number]

defineProps<{
  devices: readonly Device[]
  nextAfter: string | null
  admin: boolean
  busy: boolean
}>()
const confirmation = defineModel<string>('confirmation', { required: true })
const emit = defineEmits<{
  decide: [device: Device, operation: 'approve' | 'revoke']
  next: []
}>()

const tones = { pending: 'paused', approved: 'idle', revoked: 'error' } as const
const labels = {
  pending: 'Pendente',
  approved: 'Aprovado',
  revoked: 'Revogado',
} as const

function date(value: number) {
  return formatDateTime(value) ?? 'Indisponível'
}
</script>

<template>
  <OnboardingPanel
    heading-id="records-heading"
    title="Registros da farm"
    :summary="
      devices.length === 1 ? '1 registro' : `${devices.length} registros`
    "
    :busy="busy"
  >
    <EmptyState
      v-if="!devices.length"
      :level="3"
      title="Nenhum dispositivo nesta página"
      description="Ainda não há registros nesta farm. Crie uma chave neste navegador e solicite o cadastro para começar."
    />
    <template v-if="admin">
      <p>
        Para aprovar ou revogar, confira a impressão digital com o titular e
        digite o valor completo.
      </p>
      <OnboardingField
        id="fingerprint-confirmation"
        label="Impressão digital confirmada"
        v-slot="{ describedBy }"
      >
        <input
          id="fingerprint-confirmation"
          v-model="confirmation"
          class="mono"
          autocomplete="off"
          spellcheck="false"
          :aria-describedby="describedBy"
          :disabled="busy"
        />
      </OnboardingField>
    </template>
    <ul v-if="devices.length" class="records" aria-label="Dispositivos da farm">
      <li v-for="device in devices" :key="device.keyId">
        <dl>
          <div>
            <dt>Conta titular</dt>
            <dd>{{ device.accountId }}</dd>
          </div>
          <div>
            <dt>Impressão digital</dt>
            <dd>
              <code>{{ device.thumbprint }}</code>
            </dd>
          </div>
          <div>
            <dt>Estado</dt>
            <dd>
              <StatusBadge
                :tone="tones[device.status]"
                :label="labels[device.status]"
              />
            </dd>
          </div>
          <div>
            <dt>Criado em</dt>
            <dd>{{ date(device.createdAt) }}</dd>
          </div>
          <div v-if="device.pendingExpiresAt">
            <dt>Prazo do pedido</dt>
            <dd>{{ date(device.pendingExpiresAt) }}</dd>
          </div>
        </dl>
        <div v-if="admin" class="actions">
          <Button
            v-if="device.status === 'pending'"
            :disabled="
              busy ||
              device.proofAt === null ||
              confirmation !== device.thumbprint
            "
            @click="emit('decide', device, 'approve')"
          >
            Aprovar dispositivo
          </Button>
          <Button
            v-if="device.status !== 'revoked'"
            class="danger"
            :disabled="busy || confirmation !== device.thumbprint"
            @click="emit('decide', device, 'revoke')"
          >
            Revogar definitivamente
          </Button>
        </div>
      </li>
    </ul>
    <div v-if="nextAfter" class="actions">
      <Button :disabled="busy" @click="emit('next')">
        Próxima página de dispositivos
      </Button>
    </div>
  </OnboardingPanel>
</template>

<style scoped>
.mono,
code {
  font-family: ui-monospace, monospace;
}
code,
dd {
  overflow-wrap: anywhere;
}
.records {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
}
li {
  display: grid;
  gap: var(--space-3);
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
dl {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr));
  gap: var(--space-3) var(--space-4);
  margin: 0;
}
dl > div {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
}
dt {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}
dd {
  margin: 0;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
}
.danger {
  --accent: var(--state-error-color);
}
@media (max-width: 30rem) {
  .actions :deep(.ui-button) {
    width: 100%;
  }
}
</style>
