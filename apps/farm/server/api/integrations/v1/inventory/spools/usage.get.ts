import { defineEventHandler } from 'nuxt/server'
import { integrationAuthPool } from '../../../../../utils/integration-auth-runtime.ts'
import { integrationProblem } from '../../../../../utils/integration-auth-http.ts'
import type { IntegrationPrincipal } from '../../../../../utils/integration-auth.ts'
import {
  listIntegrationSpoolUsage,
  spoolUsageQuery,
} from '../../../../../utils/integration-inventory-ledger.ts'
import { inventoryGrantFarms } from '../../../../../utils/integration-read.ts'

export default defineEventHandler(async (event) => {
  const headers = event.res.headers
  const query = spoolUsageQuery(new URL(event.req.url).searchParams)
  if (!query) return integrationProblem('invalid-request', headers)
  const farms = inventoryGrantFarms(
    event.context.integrationAuth as IntegrationPrincipal,
    query.farmId,
  )
  if (!farms.length) return integrationProblem('not-found', headers)
  try {
    return await listIntegrationSpoolUsage(integrationAuthPool(), farms, query)
  } catch {
    return integrationProblem('service-unavailable', headers)
  }
})
