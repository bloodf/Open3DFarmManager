import { defineEventHandler } from 'nuxt/server'
import { integrationSpoolPool } from '../../../../../../../services/spool-usage.ts'
import { integrationProblem } from '../../../../../../../utils/integration-auth-http.ts'
import {
  physicalSpoolAccess,
  physicalSpoolBody,
} from '../../../../../../../utils/integration-spool-physical-http.ts'
import {
  physicalSpoolId,
  withdrawPhysicalSpool,
  withdrawal,
} from '../../../../../../../utils/integration-spool-physical.ts'

export default defineEventHandler(async (event) => {
  const headers = event.res.headers
  const access = physicalSpoolAccess(event, 'inventory:write')
  if (access instanceof Response) return access
  const id = physicalSpoolId(event.context.params?.spoolId)
  if (id === null) return integrationProblem('invalid-request', headers)
  const body = await physicalSpoolBody(event, withdrawal)
  if (body instanceof Response) return body
  try {
    const result = await withdrawPhysicalSpool(
      await integrationSpoolPool(),
      access,
      id,
      body,
    )
    if (!result) return integrationProblem('not-found', headers)
    if (result.outcome === 'changed')
      return integrationProblem('spool-location-changed', headers)
    return result
  } catch {
    return integrationProblem('service-unavailable', headers)
  }
})
