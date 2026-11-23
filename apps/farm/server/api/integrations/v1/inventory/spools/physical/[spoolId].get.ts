import { defineEventHandler } from 'nuxt/server'
import { integrationSpoolPool } from '../../../../../../services/spool-usage.ts'
import { integrationProblem } from '../../../../../../utils/integration-auth-http.ts'
import type { IntegrationPrincipal } from '../../../../../../utils/integration-auth.ts'
import { inventoryGrantFarms } from '../../../../../../utils/integration-read.ts'
import { physicalSpoolAccess } from '../../../../../../utils/integration-spool-physical-http.ts'
import {
  physicalSpoolId,
  readPhysicalSpool,
} from '../../../../../../utils/integration-spool-physical.ts'

export default defineEventHandler(async (event) => {
  const headers = event.res.headers
  const principal = event.context.integrationAuth as IntegrationPrincipal
  const scope = 'inventory:read'
  const access = physicalSpoolAccess(
    event,
    principal,
    scope,
    inventoryGrantFarms(principal, undefined, scope),
  )
  if (access instanceof Response) return access
  const id = physicalSpoolId(event.context.params?.spoolId)
  if (id === null) return integrationProblem('invalid-request', headers)
  try {
    return (
      (await readPhysicalSpool(await integrationSpoolPool(), access, id)) ??
      integrationProblem('not-found', headers)
    )
  } catch {
    return integrationProblem('service-unavailable', headers)
  }
})
