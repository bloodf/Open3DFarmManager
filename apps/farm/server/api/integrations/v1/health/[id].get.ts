import { defineEventHandler } from 'nuxt/server'
import { integrationProblem } from '../../../../utils/integration-auth-http.ts'
import {
  integrationAuthPool,
  integrationAuthRuntime,
} from '../../../../utils/integration-auth-runtime.ts'
import type { IntegrationPrincipal } from '../../../../utils/integration-auth.ts'
import {
  authorizedPrinter,
  projectHealth,
} from '../../../../utils/integration-telemetry.ts'

export default defineEventHandler(async (event) => {
  const headers = event.res.headers
  headers.set('cache-control', 'no-store')
  if ([...new URL(event.req.url).searchParams].length)
    return integrationProblem('invalid-request', headers)
  try {
    const id = (event.context.params?.id ?? '').toLowerCase()
    const store = integrationAuthRuntime().store
    if (!store.readPrinter)
      return integrationProblem('service-unavailable', headers)
    const row = authorizedPrinter(
      event.context.integrationAuth as IntegrationPrincipal,
      await store.readPrinter(id),
      id,
    )
    if (!row || !row.agentId) return integrationProblem('not-found', headers)
    const sql = integrationAuthPool()
    const rows = await sql<
      { lastSeenAt: number; health: unknown }[]
    >`SELECT last_seen_at::float8 AS "lastSeenAt", health FROM farm.connector_heartbeats WHERE farm_id = ${row.farmId}::uuid AND agent_id = ${row.agentId}::uuid`
    return {
      printerId: row.id,
      ...projectHealth(rows[0] ?? null, row.printerKey),
    }
  } catch {
    return integrationProblem('service-unavailable', headers)
  }
})
