import { createError, type RequestEvent } from 'nuxt/server'
import { authResponse, sealedSessionRecordId } from './authenticated-session.ts'
import { authRuntime, type AuthRuntime } from '../utils/auth/runtime.ts'
import { inventoryUuid } from '../storage/postgres-connector-inventory.ts'
import { farmNetworkRuntime } from '../utils/farm-network/runtime.ts'
import type {
  FarmNetworkFailure,
  FarmNetworkReader,
} from '../storage/postgres-farm-network.ts'
import { projectNetwork } from '../utils/network-projection.ts'

/** A farm the caller cannot see does not exist for the caller (same as printer states). */
function networkFailure(failure: FarmNetworkFailure): never {
  switch (failure.reason) {
    case 'invalid-input':
      throw createError({ status: 400, message: 'Farm inválida.' })
    case 'unauthorized':
      throw createError({
        status: 401,
        message: 'Entre novamente para consultar a rede.',
      })
    case 'forbidden':
      throw createError({
        status: 404,
        message: 'Farm indisponível para esta conta.',
      })
    case 'storage-unavailable':
      throw createError({
        status: 503,
        message: 'Rede da farm indisponível. Tente novamente.',
      })
  }
}

export async function farmNetwork(
  event: Pick<RequestEvent, 'req' | 'res'>,
  farmId: string,
  dependencies?: { auth: AuthRuntime; reader: FarmNetworkReader },
) {
  authResponse(event)
  event.res.headers.set('Referrer-Policy', 'no-referrer')
  if (event.req.method !== 'GET')
    throw createError({ status: 405, message: 'Método não permitido.' })
  if (!inventoryUuid.test(farmId))
    throw createError({ status: 400, message: 'Farm inválida.' })
  const auth = dependencies?.auth ?? authRuntime()
  const sessionRecordId = await sealedSessionRecordId(event, auth)
  const reader = dependencies?.reader ?? farmNetworkRuntime()
  const result = await reader.read({
    farmId,
    sessionRecordId,
    policy: { idleTimeoutMs: auth.idleTimeoutMs },
  })
  if (!result.ok) return networkFailure(result)
  return projectNetwork(result)
}
