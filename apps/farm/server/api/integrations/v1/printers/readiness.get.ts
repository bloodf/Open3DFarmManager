import { defineEventHandler } from 'nuxt/server'
import { integrationProblem } from '../../../../utils/integration-auth-http.ts'
import { integrationAuthRuntime } from '../../../../utils/integration-auth-runtime.ts'
import { listIntegrationPrinterReadiness } from '../../../../utils/integration-printers-readiness.ts'
import type { IntegrationPrincipal } from '../../../../utils/integration-auth.ts'

export default defineEventHandler(async (event) => {
  const headers = event.res.headers
  const principal = event.context.integrationAuth as IntegrationPrincipal
  try {
    const store = integrationAuthRuntime().store
    const readPrinters = store.readPrinters
    const readPrinter = store.readPrinter
    if (!readPrinters || !readPrinter)
      return integrationProblem('service-unavailable', headers)
    const result = await listIntegrationPrinterReadiness(
      principal,
      {
        readPrinters: (input) => readPrinters.call(store, input),
        readPrinter: (id) => readPrinter.call(store, id),
      },
      new URL(event.req.url).searchParams,
    )
    if ('error' in result && result.error)
      return integrationProblem(result.error, headers)
    return result
  } catch {
    return integrationProblem('service-unavailable', headers)
  }
})
