import { defineEventHandler } from 'nuxt/server'
import { integrationProblem } from '../../../../../utils/integration-auth-http.ts'
import { integrationJobsRuntime } from '../../../../../utils/integration-jobs-runtime.ts'
import { submitIntegrationJobRequest } from '../../../../../utils/integration-jobs-http.ts'
import type { IntegrationPrincipal } from '../../../../../utils/integration-auth.ts'

export default defineEventHandler(async (event) => {
  const headers = event.res.headers
  const principal = event.context.integrationAuth as IntegrationPrincipal
  let service
  try {
    service = (await integrationJobsRuntime()).service
  } catch {
    return integrationProblem('service-unavailable', headers)
  }
  return submitIntegrationJobRequest(
    event.req,
    principal,
    event.context.params?.id ?? '',
    service,
    headers,
  )
})
