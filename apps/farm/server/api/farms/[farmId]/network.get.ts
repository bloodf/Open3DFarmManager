import { createError, defineEventHandler, getRouterParam } from 'nuxt/server'
import { farmNetwork } from '../../../services/farm-network.ts'
export default defineEventHandler((event) => {
  const farmId = getRouterParam(event, 'farmId')
  if (!farmId) throw createError({ status: 400, message: 'Farm inválida.' })
  return farmNetwork(event, farmId)
})
