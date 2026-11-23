import { defineEventHandler } from 'nuxt/server'
import { integrationProblem } from '../../../../../../utils/integration-auth-http.ts'
import { integrationAuthRuntime } from '../../../../../../utils/integration-auth-runtime.ts'
import type { IntegrationPrincipal } from '../../../../../../utils/integration-auth.ts'
import { submitEnvironmentControlRequest } from '../../../../../../utils/integration-environment-controls-http.ts'
import { integrationEnvironmentControlPorts } from '../../../../../../utils/integration-environment-controls-runtime.ts'

export default defineEventHandler(async (event) => {
  const headers = event.res.headers
  const principal = event.context.integrationAuth as IntegrationPrincipal
  try {
    const store = integrationAuthRuntime().store
    const readPrinter = store.readPrinter
    if (!readPrinter) return integrationProblem('service-unavailable', headers)
    return submitEnvironmentControlRequest(
      event.req,
      principal,
      event.context.params?.printerId ?? '',
      {
        readPrinter: (id) => readPrinter.call(store, id),
        ports: integrationEnvironmentControlPorts(),
        now: Date.now,
      },
      headers,
    )
  } catch {
    return integrationProblem('service-unavailable', headers)
  }
})
