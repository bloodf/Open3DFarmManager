import { defineEventHandler } from 'nuxt/server'
import { signallingRuntime } from '../../../../../services/signalling-runtime-bootstrap.ts'
import { readIntegrationApiQuery } from '../../../../../utils/integration-api-query.ts'
import { integrationProblem } from '../../../../../utils/integration-auth-http.ts'
import { integrationAuthRuntime } from '../../../../../utils/integration-auth-runtime.ts'
import type { IntegrationPrincipal } from '../../../../../utils/integration-auth.ts'

export default defineEventHandler(async (event) => {
  const headers = event.res.headers
  try {
    return await readIntegrationApiQuery({
      request: event.req,
      headers,
      principal: event.context.integrationAuth as IntegrationPrincipal,
      printerId: event.context.params?.id ?? '',
      kind: 'files',
      store: integrationAuthRuntime().store,
      inbox: signallingRuntime(),
    })
  } catch {
    return integrationProblem('service-unavailable', headers)
  }
})
