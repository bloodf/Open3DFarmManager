import { randomBytes, randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'
import {
  openWebhookSecret,
  sealWebhookSecret,
} from '../utils/webhooks/secret.ts'
import {
  webhookRetrySeconds,
  type WebhookDelivery,
} from '../services/webhook-delivery.ts'

export const webhookEvents = [
  'printer.state_changed',
  'printer.alert.raised',
  'job.status_changed',
  'action.status_changed',
  'job.ended',
  'inventory.changed',
  'library.version.created',
  'webhook.test',
] as const

interface Webhook {
  id: string
  url: string
  events: string[]
  description: string | null
  createdAt: number
}

export interface WebhookInput {
  url: string
  events: string[]
  description?: string
}

function view({ description, ...row }: Webhook) {
  return description === null ? row : { ...row, description }
}

export class PostgresWebhooks {
  private readonly sql: Sql
  private readonly secretKey: string

  constructor(sql: Sql, secretKey: string) {
    this.sql = sql
    this.secretKey = secretKey
  }

  async sandbox(appId: string) {
    const [app] = await this.sql<{ sandbox: boolean }[]>`
      SELECT sandbox FROM farm.integration_apps WHERE id = ${appId} AND revoked_at IS NULL
    `
    return app?.sandbox
  }

  async list(appId: string, after: string | null, limit: number) {
    const rows = await this.sql<Webhook[]>`
      SELECT id, url, events, description, created_at::float8 AS "createdAt"
      FROM farm.integration_webhooks
      WHERE app_id = ${appId} AND (${after}::uuid IS NULL OR id > ${after}::uuid)
      ORDER BY id LIMIT ${limit + 1}
    `
    const data = rows.slice(0, limit).map(view)
    const last = data.at(-1)
    return {
      data,
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(last.id).toString('base64url')
          : null,
    }
  }

  async create(appId: string, input: WebhookInput) {
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${appId}, 47))`
      const [state] = await tx<{ allowed: boolean; full: boolean }[]>`
        SELECT farm.integration_webhook_allowed(${appId}, NULL, NULL) AS allowed,
          (SELECT count(*) >= 20 FROM farm.integration_webhooks WHERE app_id = ${appId}) AS full
      `
      if (!state?.allowed) return 'insufficient-scope'
      if (state.full) return 'webhook-limit-reached'
      const id = randomUUID()
      const signingSecret = randomBytes(32).toString('base64url')
      const createdAt = Date.now()
      await tx`
        INSERT INTO farm.integration_webhooks (id, app_id, url, events, description, signing_secret, created_at)
        VALUES (${id}, ${appId}, ${input.url}, ${input.events}, ${input.description ?? null}, ${sealWebhookSecret(signingSecret, this.secretKey)}, ${createdAt})
      `
      return { id, ...input, createdAt, signingSecret }
    })
  }

  async delete(appId: string, id: string) {
    const rows = await this
      .sql`DELETE FROM farm.integration_webhooks WHERE id = ${id} AND app_id = ${appId} RETURNING id`
    return rows.length > 0
  }

  async queueTest(appId: string, id: string) {
    const eventId = randomUUID()
    const body = {
      id: eventId,
      type: 'webhook.test',
      occurredAt: Date.now(),
      data: { webhookId: id },
    }
    const rows = await this.sql`
      INSERT INTO farm.integration_webhook_outbox (subscription_id, event_id, body)
      SELECT id, ${eventId}, ${this.sql.json(body)}
      FROM farm.integration_webhooks
      WHERE id = ${id} AND app_id = ${appId} AND farm.integration_webhook_allowed(app_id, NULL, NULL)
      RETURNING event_id
    `
    return rows.length ? { eventId } : null
  }

  async claim() {
    const [delivery] = await this.sql<WebhookDelivery[]>`
      WITH due AS (
        SELECT subscription_id, event_id FROM farm.integration_webhook_outbox
        WHERE status = 'pending' AND next_at <= clock_timestamp()
        ORDER BY next_at LIMIT 1 FOR UPDATE SKIP LOCKED
      )
      UPDATE farm.integration_webhook_outbox o
      SET next_at = clock_timestamp() + interval '30 seconds', attempts = o.attempts + 1
      FROM due, farm.integration_webhooks w, farm.integration_apps a
      WHERE (o.subscription_id, o.event_id) = (due.subscription_id, due.event_id)
        AND w.id = o.subscription_id AND a.id = w.app_id
      RETURNING o.subscription_id AS "subscriptionId", o.event_id AS "eventId", o.body::text AS body,
        o.attempts, w.url, w.signing_secret AS secret, a.sandbox
    `
    if (!delivery) return undefined
    const opened = openWebhookSecret(delivery.secret, this.secretKey)
    if (opened.legacy) {
      await this
        .sql`UPDATE farm.integration_webhooks SET signing_secret = ${sealWebhookSecret(opened.secret, this.secretKey)} WHERE id = ${delivery.subscriptionId} AND signing_secret = ${delivery.secret}`
    }
    return { ...delivery, secret: opened.secret }
  }

  async eligible(delivery: WebhookDelivery) {
    const [row] = await this.sql`
      SELECT 1 FROM farm.integration_webhook_outbox o
      JOIN farm.integration_webhooks w ON w.id = o.subscription_id
      WHERE o.subscription_id = ${delivery.subscriptionId} AND o.event_id = ${delivery.eventId}
        AND o.attempts = ${delivery.attempts} AND o.expires_at > clock_timestamp()
        AND farm.integration_webhook_allowed(w.app_id, o.farm_id, o.printer_id)
        AND (o.body->>'type' IS DISTINCT FROM 'printer.alert.raised'
          OR farm.integration_alert_enabled(o.farm_id, o.body#>>'{data,alert,kind}'))
    `
    return Boolean(row)
  }

  async finish(
    delivery: WebhookDelivery,
    outcome: 'delivered' | 'dead' | 'pending',
  ) {
    const delay = webhookRetrySeconds(delivery.attempts)
    await this.sql`
      UPDATE farm.integration_webhook_outbox
      SET status = CASE WHEN ${outcome} = 'pending' AND expires_at <= clock_timestamp() THEN 'dead' ELSE ${outcome} END,
        next_at = least(expires_at, clock_timestamp() + ${delay} * interval '1 second')
      WHERE subscription_id = ${delivery.subscriptionId} AND event_id = ${delivery.eventId}
        AND attempts = ${delivery.attempts}
    `
  }
}
