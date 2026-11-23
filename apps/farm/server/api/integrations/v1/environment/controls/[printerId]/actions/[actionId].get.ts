import { defineEventHandler } from 'nuxt/server'
import { integrationProblem } from '../../../../../../../utils/integration-auth-http.ts'
import type { IntegrationPrincipal } from '../../../../../../../utils/integration-auth.ts'
import { getEnvironmentControlRequest } from '../../../../../../../utils/integration-environment-controls-http.ts'
import { integrationEnvironmentControlPorts } from '../../../../../../../utils/integration-environment-controls-runtime.ts'

export default defineEventHandler(async (event) => {
  const headers = event.res.headers
  const principal = event.context.integrationAuth as IntegrationPrincipal
  try {
    return getEnvironmentControlRequest(
      principal,
      event.context.params?.printerId ?? '',
      event.context.params?.actionId ?? '',
      integrationEnvironmentControlPorts(),
      headers,
    )
  } catch {
    return integrationProblem('service-unavailable', headers)
  }
})
