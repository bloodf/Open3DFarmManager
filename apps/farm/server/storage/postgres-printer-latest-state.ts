import type { Sql, TransactionSql } from 'postgres'
import {
  PrinterState,
  type TelemetryEvent,
} from '@open3dfarmmanager/farm-protocol'
import { recordObservedAlerts } from '../utils/integration-alerts.ts'
import { MAX_FUTURE_OBSERVATION_MS } from './telemetry-clock-skew.ts'

/** Callers on schemas that may predate migration 0033 probe before writing. */
export async function latestStateTableExists(
  tx: TransactionSql,
): Promise<boolean> {
  const rows = await tx`SELECT to_regclass('farm.printer_latest_state') AS t`
  return Boolean(rows[0]?.t)
}

export async function recordLatestStates(
  tx: TransactionSql,
  scope: { farmId: string; agentId: string },
  events: readonly TelemetryEvent[],
  receivedAt = Date.now(),
): Promise<void> {
  const states = events
    .filter((event) => event.kind === 'printer-state')
    .map((event) => event.state)
    .sort(
      (a, b) =>
        Buffer.compare(Buffer.from(a.printerKey), Buffer.from(b.printerKey)) ||
        a.observedAt - b.observedAt,
    )
  let canRecordAlerts: boolean | undefined
  for (const state of states) {
    if (state.observedAt > receivedAt + MAX_FUTURE_OBSERVATION_MS) continue
    const updated =
      await tx`INSERT INTO farm.printer_latest_state (farm_id, agent_id, printer_key, observed_at, state, received_at)
      VALUES (${scope.farmId}::uuid, ${scope.agentId}::uuid, ${state.printerKey}, ${state.observedAt}, ${tx.json(state)}::jsonb, ${receivedAt})
      ON CONFLICT (farm_id, agent_id, printer_key) DO UPDATE SET observed_at = EXCLUDED.observed_at,
      received_at = EXCLUDED.received_at, state = CASE
  WHEN EXCLUDED.state ? 'machine' OR NOT (printer_latest_state.state ? 'machine') THEN EXCLUDED.state
  ELSE EXCLUDED.state || jsonb_build_object('machine', printer_latest_state.state->'machine')
END
      WHERE farm.printer_latest_state.observed_at < EXCLUDED.observed_at
        OR (printer_latest_state.received_at IS NULL
          AND printer_latest_state.observed_at > EXCLUDED.received_at + ${MAX_FUTURE_OBSERVATION_MS}::bigint)
      RETURNING printer_key`
    if (!updated.length) continue
    if (canRecordAlerts === undefined) {
      const [access] = await tx<{ allowed: boolean | null }[]>`SELECT
        has_table_privilege(to_regclass('farm.integration_alert_lifecycle'), 'INSERT') AS allowed`
      canRecordAlerts = access?.allowed === true
    }
    if (canRecordAlerts) await recordObservedAlerts(tx, scope, state)
  }
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
