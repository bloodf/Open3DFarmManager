import { createError, type RequestEvent } from 'nuxt/server'
import { authResponse, sealedSessionRecordId } from './authenticated-session.ts'
import { authRuntime, type AuthRuntime } from '../utils/auth/runtime.ts'
import { inventoryUuid } from '../storage/postgres-connector-inventory.ts'
import {
  printerStatesRuntime,
  type PrinterStateReader,
} from '../utils/printer-states/runtime.ts'
import {
  projectPrinterState,
  type PrinterStatesFailure,
} from './printer-states-core.ts'

/**
 * A farm the caller cannot see does not exist for the caller. The membership
 * check itself is the printer inventory check; only the representation of the
 * denial differs, so a non-member cannot tell an unknown farm from one that
 * exists but is not theirs.
 */
function statesFailure(failure: PrinterStatesFailure): never {
  switch (failure.reason) {
    case 'invalid-input':
      throw createError({ status: 400, message: 'Farm inválida.' })
    case 'unauthorized':
      throw createError({
        status: 401,
        message: 'Entre novamente para consultar as impressoras.',
      })
    case 'forbidden':
      throw createError({
        status: 404,
        message: 'Farm indisponível para esta conta.',
      })
    case 'storage-unavailable':
      throw createError({
        status: 503,
        message: 'Estados das impressoras indisponíveis. Tente novamente.',
      })
  }
}

export async function printerStates(
  event: Pick<RequestEvent, 'req' | 'res'>,
  farmId: string,
  dependencies?: { auth: AuthRuntime; reader: PrinterStateReader },
) {
  authResponse(event)
  event.res.headers.set('Referrer-Policy', 'no-referrer')
  if (event.req.method !== 'GET')
    throw createError({ status: 405, message: 'Método não permitido.' })
  if (!inventoryUuid.test(farmId))
    throw createError({ status: 400, message: 'Farm inválida.' })
  const auth = dependencies?.auth ?? authRuntime()
  const sessionRecordId = await sealedSessionRecordId(event, auth)
  const reader = dependencies?.reader ?? printerStatesRuntime()
  const result = await reader.list({
    farmId,
    sessionRecordId,
    policy: { idleTimeoutMs: auth.idleTimeoutMs },
  })
  if (!result.ok) return statesFailure(result)
  return { states: result.states.map(projectPrinterState) }
}
