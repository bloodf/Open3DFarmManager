import type { Sql } from 'postgres'
import {
  webhookRetrySeconds,
  type WebhookDelivery,
} from '../services/webhook-delivery.ts'
import { openNotificationChannel } from '../utils/alert-rules/delivery.ts'

type NotificationClaim = Pick<
  WebhookDelivery,
  'eventId' | 'subscriptionId' | 'body' | 'attempts'
> & { farmId: string; sealed: string }

type NotificationDelivery = NotificationClaim & WebhookDelivery

export class PostgresAlertNotifications {
  private readonly sql: Sql
  private readonly secretKey: string

  constructor(sql: Sql, secretKey: string) {
    this.sql = sql
    this.secretKey = secretKey
  }

  async claim(): Promise<NotificationDelivery | undefined> {
    const [claim] = await this.sql<NotificationClaim[]>`
      WITH due AS (
        SELECT farm_id, app_id, event_id FROM farm.integration_notification_outbox
        WHERE status = 'pending' AND next_at <= clock_timestamp()
        ORDER BY next_at LIMIT 1 FOR UPDATE SKIP LOCKED
      )
      UPDATE farm.integration_notification_outbox o
      SET next_at = clock_timestamp() + interval '30 seconds', attempts = o.attempts + 1
      FROM due, farm.integration_notification_channels c
      WHERE (o.farm_id, o.app_id, o.event_id) = (due.farm_id, due.app_id, due.event_id)
        AND (c.farm_id, c.app_id) = (o.farm_id, o.app_id)
      RETURNING o.farm_id AS "farmId", o.app_id AS "subscriptionId", o.event_id AS "eventId",
        o.body::text AS body, o.attempts, c.sealed_configuration AS sealed
    `
    if (!claim) return undefined
    let channel: ReturnType<typeof openNotificationChannel>
    try {
      channel = openNotificationChannel(claim.sealed, this.secretKey)
    } catch {
      // A deployment may temporarily lack the key that sealed this configuration.
      await this.finish(claim, 'pending')
      return undefined
    }
    if (!channel) {
      await this.finish(claim, 'dead')
      return undefined
    }
    // Saved notification destinations always use public HTTPS, including sandbox farms.
    return { ...claim, ...channel, sandbox: false }
  }

  async eligible(delivery: NotificationDelivery) {
    const [row] = await this.sql`
      SELECT 1 FROM farm.integration_notification_outbox o
      JOIN farm.integration_notification_channels c USING (farm_id, app_id)
      WHERE (o.farm_id, o.app_id, o.event_id) = (
          ${delivery.farmId}::uuid, ${delivery.subscriptionId}::uuid, ${delivery.eventId}::uuid)
        AND o.attempts = ${delivery.attempts} AND o.expires_at > clock_timestamp()
        AND c.sealed_configuration = ${delivery.sealed}
        AND farm.integration_notification_allowed(o.app_id, o.farm_id, o.printer_id)
        AND farm.integration_alert_enabled(o.farm_id, o.body#>>'{data,alert,kind}')
    `
    return Boolean(row)
  }

  async finish(
    delivery: NotificationClaim,
    outcome: 'delivered' | 'dead' | 'pending',
  ) {
    const delay = webhookRetrySeconds(delivery.attempts)
    await this.sql`
      UPDATE farm.integration_notification_outbox
      SET status = CASE WHEN ${outcome} = 'pending' AND expires_at <= clock_timestamp() THEN 'dead' ELSE ${outcome} END,
        next_at = least(expires_at, clock_timestamp() + ${delay} * interval '1 second')
      WHERE (farm_id, app_id, event_id) = (
          ${delivery.farmId}::uuid, ${delivery.subscriptionId}::uuid, ${delivery.eventId}::uuid)
        AND attempts = ${delivery.attempts}
    `
  }
}
