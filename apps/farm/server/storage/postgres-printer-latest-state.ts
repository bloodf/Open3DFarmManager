import type { Sql, TransactionSql } from 'postgres'
import {
  PrinterState,
  type TelemetryEvent,
} from '@open3dfarmmanager/farm-protocol'

export async function recordLatestStates(
  tx: TransactionSql,
  scope: { farmId: string; agentId: string },
  events: readonly TelemetryEvent[],
): Promise<void> {
  const states = events
    .filter((event) => event.kind === 'printer-state')
    .map((event) => event.state)
    .sort((a, b) =>
      Buffer.compare(Buffer.from(a.printerKey), Buffer.from(b.printerKey)),
    )
  if (!states.length) return
  const exists = (
    await tx`SELECT to_regclass('farm.printer_latest_state') AS t`
  )[0]?.t
  if (!exists) return
  for (const state of states)
    await tx`INSERT INTO farm.printer_latest_state (farm_id, agent_id, printer_key, observed_at, state)
      VALUES (${scope.farmId}::uuid, ${scope.agentId}::uuid, ${state.printerKey}, ${state.observedAt}, ${tx.json(state)}::jsonb)
      ON CONFLICT (farm_id, agent_id, printer_key) DO UPDATE SET observed_at = EXCLUDED.observed_at, state = EXCLUDED.state
      WHERE farm.printer_latest_state.observed_at < EXCLUDED.observed_at`
}

/** Internal read: caller is responsible for authorizing access to the farm. */
export async function readLatestStateByAssignment(
  sql: Sql,
  scope: { farmId: string; assignmentId: string },
): Promise<PrinterState | undefined> {
  const rows = await sql`SELECT s.state FROM farm.printer_assignments a
    JOIN farm.printer_latest_state s ON s.farm_id = a.farm_id AND s.agent_id = a.agent_id AND s.printer_key = a.printer_key
    WHERE a.farm_id = ${scope.farmId}::uuid AND a.id = ${scope.assignmentId}::uuid AND a.revoked_at IS NULL`
  return rows[0] ? PrinterState.parse(rows[0].state) : undefined
}
