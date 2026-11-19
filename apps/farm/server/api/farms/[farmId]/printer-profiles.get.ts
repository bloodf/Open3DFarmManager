import { createError, defineEventHandler, getRouterParam } from 'nuxt/server'
import { printerProfiles } from '../../../services/printer-profiles.ts'
export default defineEventHandler((event) => {
  const farmId = getRouterParam(event, 'farmId')
  if (!farmId) throw createError({ status: 400, message: 'Farm inválida.' })
  return printerProfiles(event, 'list', { farmId })
})
