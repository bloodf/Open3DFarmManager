import { defineEventHandler } from 'nuxt/server'
import { integrationProblem } from '../../../../utils/integration-auth-http.ts'
import {
  integrationAuthPool,
  integrationAuthRuntime,
} from '../../../../utils/integration-auth-runtime.ts'
import type { IntegrationPrincipal } from '../../../../utils/integration-auth.ts'
import {
  authorizedPrinter,
  historyRange,
  OBSERVATION_FRESH_MS,
  projectHistory,
  projectTransitions,
} from '../../../../utils/integration-telemetry.ts'

export default defineEventHandler(async (event) => {
  const headers = event.res.headers
  headers.set('cache-control', 'no-store')
  const range = historyRange(new URL(event.req.url).searchParams)
  if (!range) return integrationProblem('invalid-request', headers)
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
    const preceding = await sql<
      { payload: unknown }[]
    >`SELECT payload FROM farm.telemetry_events
      WHERE farm_id = ${row.farmId}::uuid AND agent_id = ${row.agentId}::uuid
        AND payload->>'kind' = 'printer-state' AND payload->'state'->>'printerKey' = ${row.printerKey}
        AND payload->'state'->>'observedAt' ~ '^[0-9]{1,16}$'
        AND (payload->'state'->>'observedAt')::bigint < ${range.since}
        AND (payload->'state'->>'observedAt')::bigint >= ${Math.max(0, range.since - OBSERVATION_FRESH_MS)}
      ORDER BY (payload->'state'->>'observedAt')::bigint DESC, event_id DESC LIMIT 1`
    const records = await sql<
      { payload: unknown }[]
    >`SELECT payload FROM farm.telemetry_events
      WHERE farm_id = ${row.farmId}::uuid AND agent_id = ${row.agentId}::uuid
        AND payload->>'kind' = 'printer-state' AND payload->'state'->>'printerKey' = ${row.printerKey}
        AND payload->'state'->>'observedAt' ~ '^[0-9]{1,16}$'
        AND (payload->'state'->>'observedAt')::bigint >= ${range.since}
        AND (payload->'state'->>'observedAt')::bigint < ${range.until}
      ORDER BY (payload->'state'->>'observedAt')::bigint, event_id LIMIT ${range.limit + 1}`
    const truncated = records.length > range.limit
    const page = records.slice(0, range.limit)
    const effectiveUntil = truncated
      ? Number(
          (records[range.limit]!.payload as { state: { observedAt: number } })
            .state.observedAt,
        )
      : range.until
    const transitions = await sql<
      { payload: unknown }[]
    >`SELECT payload FROM farm.telemetry_events
      WHERE farm_id = ${row.farmId}::uuid AND agent_id = ${row.agentId}::uuid
        AND payload->>'kind' = 'printer-transition' AND payload->'transition'->>'printerKey' = ${row.printerKey}
        AND payload->'transition'->>'observedAt' ~ '^[0-9]{1,16}$'
        AND (payload->'transition'->>'observedAt')::bigint >= ${range.since}
        AND (payload->'transition'->>'observedAt')::bigint < ${effectiveUntil}
      ORDER BY (payload->'transition'->>'observedAt')::bigint, event_id LIMIT 501`
    return {
      ...projectHistory(
        [...preceding, ...page].map((r) => r.payload),
        range.since,
        effectiveUntil,
      ),
      since: range.since,
      until: effectiveUntil,
      truncated,
      ...projectTransitions(transitions.map((r) => r.payload)),
    }
  } catch {
    return integrationProblem('service-unavailable', headers)
  }
})
