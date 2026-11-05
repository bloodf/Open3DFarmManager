import { createError, defineEventHandler, getRouterParam } from 'nuxt/server'
import { connectorPairing } from '../../../../../services/connector-pairing.ts'
import { inventoryUuid } from '../../../../../storage/postgres-connector-inventory.ts'
export default defineEventHandler((event) => {
  const farmId = getRouterParam(event, 'farmId')
  const agentId = getRouterParam(event, 'agentId')
  if (
    !farmId ||
    !agentId ||
    !inventoryUuid.test(farmId) ||
    !inventoryUuid.test(agentId)
  )
    throw createError({ status: 400, message: 'Solicitação inválida.' })
  return connectorPairing(event, 'revoke', { farmId, agentId })
})
