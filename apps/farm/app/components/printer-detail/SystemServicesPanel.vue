<script setup lang="ts">
import {
  formatNumber,
  formatPercentage,
  formatTemperature,
} from '../../utils/ui-format.ts'
import type { ServiceOperation } from '../../../../../packages/farm-protocol/src/control-actions.ts'

defineProps<{
  firmware?: { state: string; message: string }
  host?: { cpuLoad?: number; memoryBytes?: number; temperatureC?: number }
  updates?: readonly { name: string; installed: string; available: string }[]
  canCommand: boolean
  reason?: string
}>()
const emit = defineEmits<{
  restart: [operation: ServiceOperation, event: Event]
}>()
const services = {
  klipper_restart: 'Reiniciar Klipper',
  firmware_restart: 'Reiniciar firmware',
  moonraker_restart: 'Reiniciar Moonraker',
} as const
const states: Record<string, string> = {
  ready: 'Pronto',
  startup: 'Iniciando',
  shutdown: 'Desligado',
  error: 'Erro',
  disconnected: 'Desconectado',
}
</script>

<template>
  <dl>
    <dt>Estado do Klipper</dt>
    <dd>
      {{ firmware ? (states[firmware.state] ?? 'Desconhecido') : 'Sem dados' }}
    </dd>
    <template v-if="firmware?.message">
      <dt>Mensagem do Klipper</dt>
      <dd>{{ firmware.message }}</dd>
    </template>
    <dt>Uso de CPU</dt>
    <dd>
      {{
        host?.cpuLoad == null
          ? 'Sem dados'
          : (formatPercentage(host.cpuLoad) ?? 'Sem dados')
      }}
    </dd>
    <dt>Memória em uso</dt>
    <dd>
      {{
        host?.memoryBytes == null
          ? 'Sem dados'
          : formatNumber(host.memoryBytes / 1048576, {
              maximumFractionDigits: 1,
            }) + ' MiB'
      }}
    </dd>
    <dt>Temperatura da CPU</dt>
    <dd>
      {{ formatTemperature(host?.temperatureC) ?? 'Sem dados' }}
    </dd>
  </dl>
  <h2>Atualizações</h2>
  <table v-if="updates?.length">
    <thead>
      <tr>
        <th scope="col">Componente</th>
        <th scope="col">Instalada</th>
        <th scope="col">Disponível</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="component in updates" :key="component.name">
        <th scope="row">{{ component.name }}</th>
        <td>{{ component.installed || 'Sem dados' }}</td>
        <td>{{ component.available || 'Sem dados' }}</td>
      </tr>
    </tbody>
  </table>
  <p v-else>Sem dados de atualizações.</p>
  <fieldset :disabled="!canCommand">
    <legend>Reiniciar serviços</legend>
    <p v-if="!canCommand">{{ reason || 'Reinício indisponível.' }}</p>
    <button
      v-for="(label, operation) in services"
      :key="operation"
      type="button"
      @click="emit('restart', operation, $event)"
    >
      {{ label }}
    </button>
  </fieldset>
</template>
