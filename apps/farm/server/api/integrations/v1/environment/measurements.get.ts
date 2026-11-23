import { defineEventHandler } from 'nuxt/server'
import { integrationProblem } from '../../../../utils/integration-auth-http.ts'
import { integrationAuthRuntime } from '../../../../utils/integration-auth-runtime.ts'
import type { IntegrationPrincipal } from '../../../../utils/integration-auth.ts'
import { listIntegrationEnvironment } from '../../../../utils/integration-environment.ts'

export default defineEventHandler(async (event) => {
  const headers = event.res.headers
  const principal = event.context.integrationAuth as IntegrationPrincipal
  try {
    const store = integrationAuthRuntime().store
    const readPrinters = store.readPrinters
    if (!readPrinters) return integrationProblem('service-unavailable', headers)
    const result = await listIntegrationEnvironment(
      principal,
      { readPrinters: (input) => readPrinters.call(store, input) },
      new URL(event.req.url).searchParams,
    )
    if ('error' in result && result.error)
      return integrationProblem(result.error, headers)
    return result
  } catch {
    return integrationProblem('service-unavailable', headers)
  }
})
