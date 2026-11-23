import { createError, defineEventHandler, getRouterParam } from 'nuxt/server'
import {
  authenticatedSession,
  authResponse,
} from '../../../../../services/authenticated-session.ts'
import { authRuntime } from '../../../../../utils/auth/runtime.ts'
import { integrationAuthPool } from '../../../../../utils/integration-auth-runtime.ts'
import { readMemberFleetMode } from '../../../../../storage/fleet-mode-postgres.ts'
import { uuidPattern } from '../../../../../utils/integration-auth.ts'

export default defineEventHandler(async (event) => {
  authResponse(event)
  const farmId = getRouterParam(event, 'farmId') ?? ''
  const printerId = getRouterParam(event, 'assignmentId') ?? ''
  if (!uuidPattern.test(farmId) || !uuidPattern.test(printerId))
    throw createError({ status: 404, message: 'Impressora não encontrada.' })
  const { accountId } = await authenticatedSession(event, authRuntime())
  const row = await readMemberFleetMode(
    integrationAuthPool(),
    farmId,
    printerId,
    accountId,
  )
  if (!row)
    throw createError({ status: 404, message: 'Impressora não encontrada.' })
  return { mode: row.mode }
})
