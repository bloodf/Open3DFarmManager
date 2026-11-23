import { defineEventHandler } from 'nuxt/server'
import { parseAlertAction } from '../../../../../utils/integration-alerts.ts'
import {
  integrationProblem,
  readText,
} from '../../../../../utils/integration-auth-http.ts'
import {
  integrationAuthPool,
  integrationAuthRuntime,
} from '../../../../../utils/integration-auth-runtime.ts'
import {
  uuidPattern,
  type IntegrationPrincipal,
} from '../../../../../utils/integration-auth.ts'

import { authorizedPrinterForScope } from '../../../../../utils/integration-telemetry.ts'

export default defineEventHandler(async (event) => {
  const headers = event.res.headers
  headers.set('cache-control', 'no-store')
  const printerId = (event.context.params?.id ?? '').toLowerCase()
  const alertId = (event.context.params?.alertId ?? '').toLowerCase()
  if (!uuidPattern.test(printerId) || !uuidPattern.test(alertId))
    return integrationProblem('not-found', headers)
  const request = event.req
  let action
  try {
    if (
      new URL(request.url).searchParams.size ||
      request.headers.get('content-encoding') ||
      request.headers
        .get('content-type')
        ?.split(';')[0]
        ?.trim()
        .toLowerCase() !== 'application/json'
    )
      return integrationProblem('invalid-request', headers)
    action = parseAlertAction(
      JSON.parse(await readText(request, 1024)),
      Date.now(),
    )
    if (!action) return integrationProblem('invalid-request', headers)
  } catch {
    return integrationProblem('invalid-request', headers)
  }

  try {
    const store = integrationAuthRuntime().store
    if (!store.readPrinter)
      return integrationProblem('service-unavailable', headers)
    const printer = authorizedPrinterForScope(
      event.context.integrationAuth as IntegrationPrincipal,
      await store.readPrinter(printerId),
      printerId,
      'alerts:write',
    )
    if (!printer) return integrationProblem('not-found', headers)
    const sql = integrationAuthPool()
    const [updated] = await sql`UPDATE farm.integration_alert_lifecycle SET
      acknowledged_at = COALESCE(acknowledged_at, ${action.acknowledgedAt}::bigint),
      silenced_until = GREATEST(silenced_until, ${action.silencedUntil}::bigint)
      WHERE printer_id = ${printerId}::uuid AND id = ${alertId}::uuid AND resolved_at IS NULL
      RETURNING id, acknowledged_at::float8 AS "acknowledgedAt", silenced_until::float8 AS "silencedUntil"`
    if (!updated) return integrationProblem('not-found', headers)
    return updated
  } catch {
    return integrationProblem('service-unavailable', headers)
  }
})
