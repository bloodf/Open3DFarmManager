import { defineEventHandler } from 'nuxt/server'
import { integrationSpoolPool } from '../../../../../../services/spool-usage.ts'
import {
  integrationBase,
  integrationProblem,
} from '../../../../../../utils/integration-auth-http.ts'
import type { IntegrationPrincipal } from '../../../../../../utils/integration-auth.ts'
import { IDEMPOTENCY_KEY_PATTERN } from '../../../../../../services/integration-jobs.ts'
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
  const key = event.req.headers.get('idempotency-key')
  if (key === null || !IDEMPOTENCY_KEY_PATTERN.test(key))
    return integrationProblem('invalid-request', headers)
  const body = await physicalSpoolBody(event, registration)
  if (body instanceof Response) return body
  try {
    const spool = await registerPhysicalSpool(
      await integrationSpoolPool(),
      access,
      body,
      key,
    )
    if (!spool) return integrationProblem('not-found', headers)
    if (spool.outcome === 'key-reused')
      return integrationProblem('idempotency-key-reused', headers)
    const responseHeaders = new Headers(headers)
    responseHeaders.set(
      'location',
      `${integrationBase}/inventory/spools/physical/${spool.spool.spoolId}?farmId=${spool.spool.farmId}`,
    )
    return Response.json(spool.spool, { status: 201, headers: responseHeaders })
  } catch {
    return integrationProblem('service-unavailable', headers)
  }
})
