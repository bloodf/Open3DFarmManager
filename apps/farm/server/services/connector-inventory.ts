import { createError, type RequestEvent } from 'nuxt/server'
import { authResponse, sealedSessionRecordId } from './authenticated-session.ts'
import type { AuthRuntime } from '../utils/auth/runtime.ts'
import type { PostgresConnectorInventory } from '../storage/postgres-connector-inventory.ts'
import { authRuntime } from '../utils/auth/runtime.ts'
import { connectorInventoryRuntime } from '../utils/connector-inventory/runtime.ts'
import {
  inventoryUuid,
  type InventoryFailure,
} from '../storage/postgres-connector-inventory.ts'

export function parseInventoryPage(url: string): {
  limit: number
  after: string | null
} {
  const query = new URL(url).searchParams
  const limit = query.get('limit') ?? '20'
  const after = query.get('after')
  if (
    [...query.keys()].some((key) => !['limit', 'after'].includes(key)) ||
    query.getAll('limit').length > 1 ||
    query.getAll('after').length > 1 ||
    !/^(?:[1-9]|[1-4][0-9]|50)$/.test(limit) ||
    (after !== null && !inventoryUuid.test(after))
  )
    throw createError({ status: 400, message: 'Paginação inválida.' })
  return { limit: Number(limit), after }
}
function inventoryError(failure: InventoryFailure): never {
  switch (failure.reason) {
    case 'invalid-input':
      throw createError({ status: 400, message: 'Solicitação inválida.' })
    case 'unauthorized':
      throw createError({
        status: 401,
        message: 'Entre novamente para consultar suas farms.',
      })
    case 'forbidden':
      throw createError({
        status: 403,
        message: 'Farm indisponível para esta conta.',
      })
    case 'storage-unavailable':
      throw createError({
        status: 503,
        message: 'Inventário indisponível. Tente novamente.',
      })
  }
}
export async function connectorInventory(
  event: Pick<RequestEvent, 'req' | 'res'>,
  farmId?: string,
  dependencies?: { auth: AuthRuntime; storage: PostgresConnectorInventory },
) {
  authResponse(event)
  const page = parseInventoryPage(event.req.url)
  if (farmId !== undefined && !inventoryUuid.test(farmId))
    throw createError({ status: 400, message: 'Farm inválida.' })
  const auth = dependencies?.auth ?? authRuntime()
  const sessionRecordId = await sealedSessionRecordId(event, auth)
  const storage = dependencies?.storage ?? connectorInventoryRuntime()
  const input = {
    ...page,
    sessionRecordId,
    policy: { idleTimeoutMs: auth.idleTimeoutMs },
  }
  if (farmId === undefined) {
    const result = await storage.listFarms(input)
    if (!result.ok) return inventoryError(result)
    return { farms: result.farms, nextAfter: result.nextAfter }
  }
  const result = await storage.listConnectors({ ...input, farmId })
  if (!result.ok) return inventoryError(result)
  return { connectors: result.connectors, nextAfter: result.nextAfter }
}
