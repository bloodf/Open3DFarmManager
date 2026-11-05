import { createError, defineEventHandler, getRouterParam } from 'nuxt/server'
import { printerAssignments } from '../../../../../services/printer-assignments.ts'
export default defineEventHandler((event) => {
  const farmId = getRouterParam(event, 'farmId')
  const assignmentId = getRouterParam(event, 'assignmentId')
  if (!farmId || !assignmentId)
    throw createError({ status: 400, message: 'Atribuição inválida.' })
  return printerAssignments(event, 'revoke', {
    farmId,
    assignmentId,
  })
})
