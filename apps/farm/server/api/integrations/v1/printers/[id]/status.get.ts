import { defineEventHandler } from 'nuxt/server'
import { integrationProblem } from '../../../../../utils/integration-auth-http.ts'
import { integrationAuthRuntime } from '../../../../../utils/integration-auth-runtime.ts'
import { getIntegrationPrinterStatus } from '../../../../../utils/integration-printers.ts'
import type { IntegrationPrincipal } from '../../../../../utils/integration-auth.ts'

export default defineEventHandler(async (event) => {
  const headers = event.res.headers
  const principal = event.context.integrationAuth as IntegrationPrincipal
  try {
    const store = integrationAuthRuntime().store
    const readPrinter = store.readPrinter
    if (!readPrinter) return integrationProblem('service-unavailable', headers)
    const result = await getIntegrationPrinterStatus(
      principal,
      { readPrinter: (id) => readPrinter.call(store, id) },
      event.context.params?.id ?? '',
    )
    if ('error' in result && result.error)
      return integrationProblem(result.error, headers)
    return result
  } catch {
    return integrationProblem('service-unavailable', headers)
  }
})
