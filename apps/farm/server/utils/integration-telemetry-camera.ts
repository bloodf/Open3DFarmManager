import { HeartbeatHealth } from '@open3dfarmmanager/farm-protocol'
import type { Sql } from 'postgres'
import type { IntegrationPrinterRow } from './integration-auth.ts'
import { OBSERVATION_FRESH_MS } from './integration-telemetry.ts'

export async function cameraEnabled(
  sql: Sql,
  printer: IntegrationPrinterRow,
  now = Date.now(),
) {
  if (!printer.agentId) return false
  const [heartbeat] = await sql<{ health: unknown }[]>`SELECT health
    FROM farm.connector_heartbeats
    WHERE farm_id = ${printer.farmId}::uuid AND agent_id = ${printer.agentId}::uuid
      AND last_seen_at BETWEEN ${now - OBSERVATION_FRESH_MS} AND ${now}`
  const health = HeartbeatHealth.safeParse(heartbeat?.health)
  return (
    health.success &&
    health.data.connector.rtcScope !== 'disabled' &&
    health.data.cameraAssignments?.includes(printer.id) === true
  )
}
