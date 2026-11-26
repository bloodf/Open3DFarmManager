import { createError, type RequestEvent } from 'nuxt/server'
import { readMemberFleetMode } from '../storage/fleet-mode-postgres.ts'
import { uuidPattern } from '../utils/integration-auth.ts'
import {
  integrationAuthConfigured,
  integrationAuthPool,
} from '../utils/integration-auth-runtime.ts'
import { printerAssignmentsRuntime } from '../utils/printer-assignments/runtime.ts'
import { authRuntime } from '../utils/auth/runtime.ts'
import {
  authenticatedSession,
  authResponse,
  sealedSessionRecordId,
} from './authenticated-session.ts'

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
  if (!integrationAuthConfigured()) {
    const auth = authRuntime()
    const sessionRecordId = await sealedSessionRecordId(event, auth)
    const { profiles } = await printerAssignmentsRuntime()
    const result = await profiles.read({
      sessionRecordId,
      policy: { idleTimeoutMs: auth.idleTimeoutMs },
      farmId,
      assignmentId: printerId,
    })
    if (!result.ok) {
      if (result.reason === 'forbidden' || result.reason === 'not-found')
        throw createError({
          status: 404,
          message: 'Impressora não encontrada.',
        })
      throw createError({
        status: result.reason === 'unauthorized' ? 401 : 503,
        message: 'Impressora indisponível.',
      })
    }
    return { mode: 'in-service' as const }
  }
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
