import { createError, defineEventHandler, getRouterParam } from 'nuxt/server'
import { statusSummary } from '../../../services/status-summary.ts'
export default defineEventHandler((event) => {
  const farmId = getRouterParam(event, 'farmId')
  if (!farmId) throw createError({ status: 400, message: 'Farm inválida.' })
  return statusSummary(event, farmId)
})
