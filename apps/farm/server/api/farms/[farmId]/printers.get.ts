import { createError, defineEventHandler, getRouterParam } from 'nuxt/server'
import { printerAssignments } from '../../../services/printer-assignments.ts'
export default defineEventHandler((event) => {
  const farmId = getRouterParam(event, 'farmId')
  if (!farmId) throw createError({ status: 400, message: 'Farm inválida.' })
  return printerAssignments(event, 'list', { farmId })
})
