import { defineEventHandler } from 'nuxt/server'
import { integrationProblem } from '../../../../../utils/integration-auth-http.ts'
import { integrationJobsRuntime } from '../../../../../utils/integration-jobs-runtime.ts'
import { submitIntegrationActionRequest } from '../../../../../utils/integration-actions-http.ts'
import type { IntegrationPrincipal } from '../../../../../utils/integration-auth.ts'

export default defineEventHandler(async (event) => {
  const headers = event.res.headers
  const principal = event.context.integrationAuth as IntegrationPrincipal
  try {
    const { service, actions } = await integrationJobsRuntime()
    const job = await service.actionTarget(
      principal,
      event.context.params?.id ?? '',
    )
    if (!job) return integrationProblem('not-found', headers)
    return submitIntegrationActionRequest(
      event.req,
      principal,
      job.printerId,
      actions,
      headers,
      job,
    )
  } catch {
    return integrationProblem('service-unavailable', headers)
  }
})
