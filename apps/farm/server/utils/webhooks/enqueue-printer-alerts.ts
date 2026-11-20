import type { Sql } from 'postgres'
import type { IntegrationPrinterRow } from '../integration-auth.ts'
import {
  PRINTER_ALERT_RAISED,
  printerAlertEventsForTransition,
} from './printer-alerts.ts'

/**
 * Queues `printer.alert.raised` deliveries for newly raised E20.6 alerts.
 * Reuses the signed-webhook outbox; secrets stay in the subscription row.
 */
export async function enqueuePrinterAlertRaised(
  sql: Sql,
  previous: IntegrationPrinterRow | null,
  current: IntegrationPrinterRow,
  nowWall = Date.now(),
) {
  const events = printerAlertEventsForTransition(previous, current, nowWall)
  for (const event of events) {
    await sql`
      INSERT INTO farm.integration_webhook_outbox (subscription_id, event_id, farm_id, printer_id, body)
      SELECT w.id, ${event.id}::uuid, ${current.farmId}::uuid, ${current.id}::uuid, ${sql.json(event)}
      FROM farm.integration_webhooks w
      WHERE ${PRINTER_ALERT_RAISED} = ANY(w.events)
        AND farm.integration_webhook_allowed(w.app_id, ${current.farmId}::uuid, ${current.id}::uuid)
    `
  }
  return events.length
}
