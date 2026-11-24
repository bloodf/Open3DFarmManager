<script setup lang="ts">
import { formatDateTime } from '../../utils/ui-format.ts'
import EmptyState from '../ui/EmptyState.vue'
import {
  describeSpoolmanResult,
  describeSpoolmanStatus,
  type SpoolmanConnectorResult,
} from '../../utils/spoolman-onboarding.ts'

export type SpoolmanSavedSetting = {
  agentId: string
  origin: string
  serviceId?: string | null
  status: 'reachable' | 'unreachable' | 'unauthorized'
  configured: boolean
  checkedAt: number
}

defineProps<{
  settings: readonly SpoolmanSavedSetting[]
  results: readonly SpoolmanConnectorResult[]
  canManage?: boolean
}>()

const when = (value: number) => formatDateTime(value, 'short') ?? 'Indisponível'
</script>

<template>
  <section aria-labelledby="spoolman-test-heading">
    <h2 id="spoolman-test-heading">Resultado do teste de conexão</h2>
    <p v-if="results.length === 0" role="status">
      Nenhum teste executado nesta sessão.
    </p>
    <ul v-else class="spoolman-results">
      <li v-for="result in results" :key="result.agentId">
        <strong>Connector {{ result.agentId.slice(0, 8) }}:</strong>
        <span :data-status="result.status">{{
          describeSpoolmanStatus(result.status)
        }}</span>
        — {{ describeSpoolmanResult(result) }}
      </li>
    </ul>
  </section>
  <section aria-labelledby="spoolman-saved-heading">
    <h2 id="spoolman-saved-heading">Configuração atual da farm</h2>
    <EmptyState
      :level="3"
      v-if="settings.length === 0"
      title="Nenhum Spoolman configurado"
      :description="
        canManage
          ? 'Informe o endereço do Spoolman no formulário acima e teste a conexão. Até lá, os Connectors continuam usando a configuração local existente, se houver.'
          : 'Peça a um proprietário ou administrador para configurar o Spoolman. Até lá, os Connectors continuam usando a configuração local existente, se houver.'
      "
    />
    <table v-else>
      <thead>
        <tr>
          <th scope="col">Connector</th>
          <th scope="col">Endereço</th>
          <th scope="col">ID do serviço</th>
          <th scope="col">Situação</th>
          <th scope="col">Última verificação</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="setting in settings" :key="setting.agentId">
          <td>{{ setting.agentId.slice(0, 8) }}</td>
          <td>{{ setting.origin }}</td>
          <td>{{ setting.serviceId ?? 'Não informado' }}</td>
          <td>
            {{ describeSpoolmanStatus(setting.status)
            }}{{ setting.configured ? '' : ' (não aplicado)' }}
          </td>
          <td>{{ when(setting.checkedAt) }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>
