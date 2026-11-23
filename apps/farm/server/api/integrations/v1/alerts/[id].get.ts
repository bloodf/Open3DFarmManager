import { defineEventHandler } from 'nuxt/server'
import { integrationProblem } from '../../../../utils/integration-auth-http.ts'
import {
  integrationAuthPool,
  integrationAuthRuntime,
} from '../../../../utils/integration-auth-runtime.ts'
import type { IntegrationPrincipal } from '../../../../utils/integration-auth.ts'
import { authorizedPrinter } from '../../../../utils/integration-telemetry.ts'

export default defineEventHandler(async (event) => {
  const headers = event.res.headers
  headers.set('cache-control', 'no-store')
  if (new URL(event.req.url).searchParams.size)
    return integrationProblem('invalid-request', headers)
  try {
    const printerId = (event.context.params?.id ?? '').toLowerCase()
    const store = integrationAuthRuntime().store
    if (!store.readPrinter)
      return integrationProblem('service-unavailable', headers)
    const printer = authorizedPrinter(
      event.context.integrationAuth as IntegrationPrincipal,
      await store.readPrinter(printerId),
      printerId,
    )
    if (!printer) return integrationProblem('not-found', headers)
    const sql = integrationAuthPool()
    const now = Date.now()
    const appId = (event.context.integrationAuth as IntegrationPrincipal).appId
    const alerts = await sql`SELECT lifecycle.id, kind, label, message,
      opened_at::float8 AS "openedAt", resolved_at::float8 AS "resolvedAt",
      actions.acknowledged_at::float8 AS "acknowledgedAt", actions.silenced_until::float8 AS "silencedUntil",
      (resolved_at IS NULL AND acknowledged_at IS NULL AND COALESCE(silenced_until <= ${now}, true)) AS "needsAttention"
      FROM farm.integration_alert_lifecycle lifecycle
      LEFT JOIN LATERAL (
        SELECT MIN(acted_at) FILTER (WHERE action = 'acknowledge') AS acknowledged_at,
          MAX(silenced_until) AS silenced_until
        FROM farm.integration_alert_actions WHERE alert_id = lifecycle.id AND app_id = ${appId}::uuid
      ) actions ON true WHERE printer_id = ${printerId}::uuid
      ORDER BY (resolved_at IS NULL) DESC, opened_at DESC, lifecycle.id DESC LIMIT 501`
    return {
      printerId,
      alerts: alerts.slice(0, 500),
      truncated: alerts.length > 500,
    }
  } catch {
    return integrationProblem('service-unavailable', headers)
  }
})
