import { createError, defineEventHandler, getRouterParam } from 'nuxt/server'
import { printerProfiles } from '../../../../../services/printer-profiles.ts'
export default defineEventHandler((event) => {
  const farmId = getRouterParam(event, 'farmId')
  const assignmentId = getRouterParam(event, 'assignmentId')
  if (!farmId || !assignmentId)
    throw createError({ status: 400, message: 'Atribuição inválida.' })
  return printerProfiles(event, 'read', { farmId, assignmentId })
})
