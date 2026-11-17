import { createError, defineEventHandler, getRouterParam } from 'nuxt/server'
import { printerStates } from '../../../services/printer-states.ts'
export default defineEventHandler((event) => {
  const farmId = getRouterParam(event, 'farmId')
  if (!farmId) throw createError({ status: 400, message: 'Farm inválida.' })
  return printerStates(event, farmId)
})
