import { createError, defineEventHandler, getRouterParam } from 'nuxt/server'
import { connectorInventory } from '../../../services/connector-inventory.ts'
export default defineEventHandler((event) => {
  const farmId = getRouterParam(event, 'farmId')
  if (!farmId) throw createError({ status: 400, message: 'Farm inválida.' })
  return connectorInventory(event, farmId)
})
