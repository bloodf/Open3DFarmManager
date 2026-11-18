import { defineEventHandler } from 'nuxt/server'
import { integrationProblem } from '../../../utils/integration-auth-http.ts'
import { integrationAuthPool } from '../../../utils/integration-auth-runtime.ts'
import type { IntegrationPrincipal } from '../../../utils/integration-auth.ts'
import {
  inventoryGrantFarms,
  listIntegrationInventory,
  validInventoryCursor,
} from '../../../utils/integration-read.ts'
import { uuidPattern } from '../../../utils/integration-auth.ts'

export default defineEventHandler(async (event) => {
  const headers = event.res.headers
  const query = new URL(event.req.url).searchParams
  const principal = event.context.integrationAuth as IntegrationPrincipal
  const limits = query.getAll('limit')
  const cursors = query.getAll('cursor')
  const farms = query.getAll('farmId')
  const limit = limits[0] ?? '50'
  const farmId = farms[0]
  const cursor = cursors[0] ?? null
  if (
    [...query.keys()].some(
      (key) => !['farmId', 'limit', 'cursor'].includes(key),
    ) ||
    limits.length > 1 ||
    cursors.length > 1 ||
    farms.length > 1 ||
    !/^(?:[1-9]\d?|100)$/.test(limit) ||
    (farmId !== undefined && !uuidPattern.test(farmId)) ||
    (cursor !== null && !/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) ||
    !validInventoryCursor(cursor)
  )
    return integrationProblem('invalid-request', headers)
  const normalizedFarmId = farmId?.toLowerCase()

  const farmIds = inventoryGrantFarms(principal, normalizedFarmId)
  if (!farmIds.length) return integrationProblem('not-found', headers)

  try {
    return await listIntegrationInventory(integrationAuthPool(), {
      farmIds,
      limit: Number(limit),
      cursor,
    })
  } catch {
    return integrationProblem('service-unavailable', headers)
  }
})
