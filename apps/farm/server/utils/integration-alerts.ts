import type { PrinterState } from '@open3dfarmmanager/farm-protocol'
import type { TransactionSql } from 'postgres'
import { alertsForPrinter } from './webhooks/printer-alerts.ts'

export async function recordObservedAlerts(
  tx: TransactionSql,
  scope: { farmId: string; agentId: string },
  state: PrinterState,
) {
  const [assignment] = await tx<{ id: string }[]>`SELECT id
    FROM farm.printer_assignments
    WHERE farm_id = ${scope.farmId}::uuid AND agent_id = ${scope.agentId}::uuid
      AND printer_key = ${state.printerKey} AND revoked_at IS NULL
      AND created_at <= ${state.observedAt}`
  if (!assignment) return
  const observedAt = state.observedAt
  const alerts = alertsForPrinter(
    {
      ...scope,
      id: assignment.id,
      printerKey: state.printerKey,
      sandbox: false,
      state,
      observedAt,
    },
    observedAt,
  ).map((alert) => ({
    ...alert,
    // The farm wall can interpolate printer-provided strings. Export fixed copy.
    message:
      alert.kind === 'error' ? 'Impressora em estado de erro.' : alert.label,
  }))
  const resolved =
    await tx`UPDATE farm.integration_alert_lifecycle SET resolved_at = greatest(opened_at, ${observedAt}::bigint)
    WHERE printer_id = ${assignment.id}::uuid AND resolved_at IS NULL
      AND (${state.state} <> 'offline' OR kind = 'offline-or-stale')
      AND NOT (alert_key = ANY(${alerts.map((alert) => alert.id)}::text[]))`
  if (alerts.length) {
    await tx`INSERT INTO farm.integration_alert_lifecycle
      (printer_id, alert_key, kind, label, message, opened_at)
      SELECT ${assignment.id}::uuid, id, kind, label, message, ${observedAt}
      FROM jsonb_to_recordset(${tx.json(alerts)}::jsonb) AS alert(id text, kind text, label text, message text)
      ON CONFLICT (printer_id, alert_key) WHERE resolved_at IS NULL DO NOTHING`
  }
  if (!resolved.count) return
  await tx`DELETE FROM farm.integration_alert_lifecycle WHERE id IN (
    SELECT id FROM farm.integration_alert_lifecycle
    WHERE printer_id = ${assignment.id}::uuid AND resolved_at IS NOT NULL
    ORDER BY opened_at DESC, id DESC OFFSET 500
  )`
}

export const MAX_SILENCE_MS = 7 * 86_400_000

export function parseAlertAction(body: unknown, now: number) {
  if (!body || typeof body !== 'object' || !('action' in body)) return null
  const fields = Object.keys(body)
  if (body.action === 'acknowledge' && fields.length === 1)
    return { acknowledgedAt: now, silencedUntil: null }
  if (
    body.action === 'silence' &&
    fields.length === 2 &&
    'until' in body &&
    typeof body.until === 'number' &&
    Number.isSafeInteger(body.until) &&
    body.until > now &&
    body.until <= now + MAX_SILENCE_MS
  )
    return { acknowledgedAt: null, silencedUntil: body.until }
  return null
}
