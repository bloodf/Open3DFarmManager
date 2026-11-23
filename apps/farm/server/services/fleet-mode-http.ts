import { createError, type RequestEvent } from 'nuxt/server'
import { readMemberFleetMode } from '../storage/fleet-mode-postgres.ts'
import { uuidPattern } from '../utils/integration-auth.ts'
import { integrationAuthPool } from '../utils/integration-auth-runtime.ts'
import { authRuntime } from '../utils/auth/runtime.ts'
import { authenticatedSession, authResponse } from './authenticated-session.ts'

/** Read availability only for an authenticated member of the assignment's farm. */
export async function farmFleetMode(
  event: Pick<RequestEvent, 'req' | 'res'>,
  farmId: string,
  printerId: string,
) {
  authResponse(event)
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
}
