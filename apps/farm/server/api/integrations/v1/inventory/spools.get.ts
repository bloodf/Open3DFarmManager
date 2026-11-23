import { defineEventHandler } from 'nuxt/server'
import { integrationProblem } from '../../../../utils/integration-auth-http.ts'
import { integrationAuthPool } from '../../../../utils/integration-auth-runtime.ts'
import {
  uuidPattern,
  type IntegrationPrincipal,
} from '../../../../utils/integration-auth.ts'
import { inventoryGrantFarms } from '../../../../utils/integration-read.ts'
import {
  listObservedSpools,
  spoolCursor,
} from '../../../../utils/integration-inventory-spools.ts'

export default defineEventHandler(async (event) => {
  const query = new URL(event.req.url).searchParams
  const headers = event.res.headers
  const limit = query.get('limit') ?? '50'
  const cursor = query.get('cursor')
  const farmId = query.get('farmId')
  if (
    [...query.keys()].some((k) => !['farmId', 'limit', 'cursor'].includes(k)) ||
    ['farmId', 'limit', 'cursor'].some((k) => query.getAll(k).length > 1) ||
    !/^(?:[1-9]\d?|100)$/.test(limit) ||
    (farmId !== null && !uuidPattern.test(farmId)) ||
    spoolCursor(cursor) === null
  )
    return integrationProblem('invalid-request', headers)
  const farms = inventoryGrantFarms(
    event.context.integrationAuth as IntegrationPrincipal,
    farmId?.toLowerCase(),
  )
  if (!farms.length) return integrationProblem('not-found', headers)
  try {
    return await listObservedSpools(integrationAuthPool(), {
      farmIds: farms,
      limit: Number(limit),
      cursor,
    })
  } catch {
    return integrationProblem('service-unavailable', headers)
  }
})
