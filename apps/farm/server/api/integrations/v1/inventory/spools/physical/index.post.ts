import { defineEventHandler } from 'nuxt/server'
import { integrationSpoolPool } from '../../../../../../services/spool-usage.ts'
import {
  integrationBase,
  integrationProblem,
} from '../../../../../../utils/integration-auth-http.ts'
import type { IntegrationPrincipal } from '../../../../../../utils/integration-auth.ts'
import { inventoryGrantFarms } from '../../../../../../utils/integration-read.ts'
import {
  physicalSpoolAccess,
  physicalSpoolBody,
} from '../../../../../../utils/integration-spool-physical-http.ts'
import {
  registerPhysicalSpool,
  registration,
} from '../../../../../../utils/integration-spool-physical.ts'

export default defineEventHandler(async (event) => {
  const headers = event.res.headers
  const principal = event.context.integrationAuth as IntegrationPrincipal
  const scope = 'inventory:write'
  const access = physicalSpoolAccess(
    event,
    principal,
    scope,
    inventoryGrantFarms(principal, undefined, scope),
  )
  if (access instanceof Response) return access
  const body = await physicalSpoolBody(event, registration)
  if (body instanceof Response) return body
  try {
    const spool = await registerPhysicalSpool(
      await integrationSpoolPool(),
      access,
      body,
    )
    if (!spool) return integrationProblem('not-found', headers)
    const responseHeaders = new Headers(headers)
    responseHeaders.set(
      'location',
      `${integrationBase}/inventory/spools/physical/${spool.spoolId}?farmId=${spool.farmId}`,
    )
    return Response.json(spool, { status: 201, headers: responseHeaders })
  } catch {
    return integrationProblem('service-unavailable', headers)
  }
})
