import { defineEventHandler } from 'nuxt/server'
import { integrationProblem } from '../../../../utils/integration-auth-http.ts'
import { alertRulesStore } from '../../../../storage/alert-rules-postgres.ts'
import {
  integrationAuthPool,
  integrationAuthRuntime,
} from '../../../../utils/integration-auth-runtime.ts'
import type { IntegrationPrincipal } from '../../../../utils/integration-auth.ts'
import { listBulkPrinterStatus } from '../../../../utils/webhooks/bulk-status.ts'

export default defineEventHandler(async (event) => {
  const headers = event.res.headers
  const principal = event.context.integrationAuth as IntegrationPrincipal
  try {
    const store = integrationAuthRuntime().store
    const readPrinters = store.readPrinters
    const readPrinter = store.readPrinter
    if (!readPrinters || !readPrinter)
      return integrationProblem('service-unavailable', headers)
    const result = await listBulkPrinterStatus(
      principal,
      {
        readPrinters: (input) => readPrinters.call(store, input),
        readPrinter: (id) => readPrinter.call(store, id),
      },
      new URL(event.req.url).searchParams,
      Date.now(),
      alertRulesStore(integrationAuthPool()).disabled,
    )
    if ('error' in result && result.error)
      return integrationProblem(result.error, headers)
    return result
  } catch {
    return integrationProblem('service-unavailable', headers)
  }
})
