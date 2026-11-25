import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { adjustSpool } from '../apps/farm/server/services/spool-usage-ledger.ts'
import { deliverNextWebhook } from '../apps/farm/server/services/webhook-worker.ts'
import { PostgresAlertNotifications } from '../apps/farm/server/storage/alert-rules-notifications-postgres.ts'
import { PostgresWebhooks } from '../apps/farm/server/storage/webhook-postgres.ts'
import { recordLatestStates } from '../apps/farm/server/storage/postgres-printer-latest-state.ts'
import { listBulkPrinterStatus } from '../apps/farm/server/utils/webhooks/bulk-status.ts'
import { credentialKeyring } from '../apps/farm/server/utils/sealed-credential-key.ts'
import { sealWebhookSecret } from '../apps/farm/server/utils/webhooks/secret.ts'
import { alertRulesStore } from '../apps/farm/server/storage/alert-rules-postgres.ts'

const port = Number(process.env.ALERT_RULES_SYNTHETIC_TEST_PORT)
if (
  process.argv.length !== 2 ||
  process.env.ALERT_RULES_SYNTHETIC_TEST_DISPOSABLE !== 'yes' ||
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535
)
  throw new Error('Explicit disposable loopback PostgreSQL port required')

const sql = postgres({
  host: '127.0.0.1',
  port,
  database: 'fixture',
  username: 'fixture',
  password: process.env.PGPASSWORD ?? '',
  max: 1,
  connect_timeout: 3,
})
const owner = `alert_owner_${randomUUID()}`
const farm = randomUUID()
const app = randomUUID()
const grant = randomUUID()
try {
  await sql`INSERT INTO farm.session_accounts (id) VALUES (${owner})`
  await sql`INSERT INTO farm.farms (id) VALUES (${farm})`
  await sql`INSERT INTO farm.memberships (farm_id, account_id, role) VALUES (${farm}, ${owner}, 'owner')`
  await sql`INSERT INTO farm.integration_apps (id, farm_id, name, sandbox, created_at, created_by) VALUES (${app}, ${farm}, 'alerts', false, 1, ${owner})`
  await sql`INSERT INTO farm.integration_app_grants (id, app_id, farm_id, scopes, created_at, created_by) VALUES (${grant}, ${app}, ${farm}, ARRAY['alerts:manage','events:subscribe','printers:read'], 1, ${owner})`
  const store = alertRulesStore(sql)
  async function change(grantId = grant, enabled = true) {
    await sql`SET ROLE farm_integration_apps`
    try {
      return await store.manage(app, farm, [grantId], async (settings) => {
        await settings.writeRule('error', enabled)
        return true
      })
    } finally {
      await sql`RESET ROLE`
    }
  }
  assert.deepEqual(await change(grant, false), { value: true })
  await sql`UPDATE farm.memberships SET role = 'viewer' WHERE farm_id = ${farm} AND account_id = ${owner}`
  assert.equal(await change(), null, 'former owner denied')
  await sql`UPDATE farm.memberships SET role = 'owner' WHERE farm_id = ${farm} AND account_id = ${owner}`
  const missingScope = randomUUID()
  const approval = randomUUID()
  await sql`INSERT INTO farm.integration_app_grants (id, app_id, farm_id, scopes, requires_approval, created_at, created_by) VALUES
    (${missingScope}, ${app}, ${farm}, ARRAY['printers:read'], false, 2, ${owner}),
    (${approval}, ${app}, ${farm}, ARRAY['alerts:manage'], true, 3, ${owner})`
  assert.equal(await change(missingScope), null, 'missing scope denied')
  assert.equal(await change(approval), null, 'approval required denied')
  assert.deepEqual(
    [...(await store.list(farm))],
    [{ kind: 'error', enabled: false }],
  )
  console.log('alert rules authorization checks passed')

  const agentId = randomUUID()
  const printerId = randomUUID()
  const printerKey = 'simulated'
  await sql`INSERT INTO farm.connector_enrollments (agent_id, farm_id, public_key_spki, fingerprint)
    VALUES (${agentId}, ${farm}, ${'k'.repeat(59)}, ${'f'.repeat(50)})`
  await sql`UPDATE farm.connector_enrollments SET status = 'approved' WHERE agent_id = ${agentId}`
  await sql`INSERT INTO farm.printer_assignments (id, farm_id, agent_id, printer_key, created_at, created_by)
    VALUES (${printerId}, ${farm}, ${agentId}, ${printerKey}, 1, ${owner})`

  const keyring = credentialKeyring({
    credentialEncryptionKey: 'synthetic-key-for-alert-delivery-fixture-only',
  })
  const channel = {
    url: 'https://channel.example.com/alerts',
    secret: 'c'.repeat(32),
  }
  const webhooks = new PostgresWebhooks(sql, keyring)
  const notifications = new PostgresAlertNotifications(sql, keyring)
  await sql`SET ROLE farm_integration_apps`
  try {
    assert.deepEqual(
      await store.manage(app, farm, [grant], async (settings) => {
        await settings.writeChannel(
          sealWebhookSecret(JSON.stringify(channel), keyring),
        )
        return true
      }),
      { value: true },
    )
    assert.equal(
      typeof (await webhooks.create(app, {
        url: 'https://subscriber.example.com/alerts',
        events: ['printer.alert.raised'],
      })),
      'object',
    )
  } finally {
    await sql`RESET ROLE`
  }

  let observedAt = Date.now()
  async function observe(state: 'error' | 'idle', time = ++observedAt) {
    await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE farm_connector_telemetry_writer`
      await recordLatestStates(tx, { farmId: farm, agentId }, [
        {
          kind: 'printer-state',
          eventId: randomUUID(),
          queuedAt: time,
          state: { printerKey, state, progress: 0, observedAt: time },
        },
      ])
    })
  }

  const queueCounts = async () => [
    ...(await sql`
    SELECT (SELECT count(*)::int FROM farm.integration_webhook_outbox WHERE status = 'pending') AS webhook,
      (SELECT count(*)::int FROM farm.integration_notification_outbox WHERE status = 'pending') AS notification
  `),
  ]
  async function bulkAlerts() {
    const scope = 'printers:read'
    const result = await listBulkPrinterStatus(
      {
        appId: app,
        scopes: [scope],
        grants: [
          {
            id: grant,
            appId: app,
            farmId: farm,
            printerAssignmentId: null,
            scopes: [scope],
            requiresApproval: false,
            createdAt: 1,
            disabledAt: null,
            disabledReason: null,
          },
        ],
      },
      {
        readPrinters: async () => [
          {
            id: printerId,
            farmId: farm,
            printerKey,
            sandbox: false,
            observedAt,
            state: { printerKey, state: 'error', progress: 0, observedAt },
          },
        ],
        readPrinter: async () => null,
      },
      new URLSearchParams(),
      observedAt,
      store.disabled,
    )
    assert.ok(result.data)
    return result.data[0]?.alerts.map(({ kind }) => kind)
  }

  await observe('error', observedAt + 120_000)
  assert.deepEqual(
    [...(await sql`SELECT kind, raised FROM farm.integration_alert_lifecycle`)],
    [{ kind: 'error', raised: false }],
    'disabled alert retained as audit',
  )
  assert.deepEqual(
    await queueCounts(),
    [{ webhook: 0, notification: 0 }],
    'disabled alert never queued',
  )
  assert.deepEqual(
    await bulkAlerts(),
    [],
    'disabled alert omitted from bulk status',
  )
  // The Connector clock fell back after opening the alert. The accepted
  // recovery must still resolve it without a negative lifecycle duration.
  await observe('idle')
  assert.equal(
    (
      await sql`SELECT resolved_at IS NOT NULL AS resolved FROM farm.integration_alert_lifecycle`
    )[0]?.resolved,
    true,
  )

  await change()
  assert.deepEqual(await bulkAlerts(), ['error'])
  await observe('error')
  await observe('error')
  assert.deepEqual(
    await queueCounts(),
    [{ webhook: 1, notification: 1 }],
    'one delivery per destination',
  )
  await sql`SET ROLE farm_integration_apps`
  try {
    assert.equal(
      await deliverNextWebhook(notifications, async (delivery) => {
        assert.equal(delivery.url, channel.url)
        assert.equal(delivery.secret, channel.secret)
        assert.equal(delivery.sandbox, false)
        const event = JSON.parse(delivery.body)
        assert.equal(event.id, delivery.eventId)
        assert.equal(event.type, 'printer.alert.raised')
        assert.equal(event.data.farmId, farm)
        assert.equal(event.data.printerId, printerId)
        assert.equal(event.data.alert.kind, 'error')
        return true
      }),
      true,
    )
    assert.equal(await deliverNextWebhook(webhooks, async () => true), true)
  } finally {
    await sql`RESET ROLE`
  }
  assert.equal(
    (await sql`SELECT status FROM farm.integration_notification_outbox`)[0]
      ?.status,
    'delivered',
  )

  await observe('idle')
  await observe('error')
  assert.deepEqual(await queueCounts(), [{ webhook: 1, notification: 1 }])
  await change(grant, false)
  let sends = 0
  const unexpected = async () => {
    sends++
    return true
  }
  assert.equal(await deliverNextWebhook(webhooks, unexpected), true)
  assert.equal(await deliverNextWebhook(notifications, unexpected), true)
  assert.equal(sends, 0, 'disable suppresses deliveries already queued')

  await sql`INSERT INTO farm.spool_filaments (farm_id, id, name, density, diameter, registered_at, low_stock_threshold_grams)
    VALUES (${farm}, 1, 'PLA', 1.24, 1.75, 1, 50)`
  await sql`INSERT INTO farm.spools (farm_id, id, filament_id, registered_at, initial_weight)
    VALUES (${farm}, 1, 1, 1, 100)`
  await sql`INSERT INTO farm.integration_alert_rules (farm_id, kind, enabled) VALUES (${farm}, 'low-slot', false)`
  const adjust = (delta: number) =>
    sql.begin((tx) =>
      adjustSpool(tx, farm, 1, delta, observedAt, observedAt, printerId),
    )
  const effect = await adjust(60)
  assert.equal(effect.remainingGrams, 40, 'stock movement is retained')
  assert.equal(effect.alerted, false)
  assert.deepEqual(await queueCounts(), [{ webhook: 0, notification: 0 }])
  await adjust(-60)
  await sql`UPDATE farm.integration_alert_rules SET enabled = true WHERE farm_id = ${farm} AND kind = 'low-slot'`
  assert.equal((await adjust(60)).alerted, true)
  assert.deepEqual(
    await queueCounts(),
    [{ webhook: 1, notification: 1 }],
    'low stock uses both destinations',
  )
  await sql`UPDATE farm.memberships SET role = 'viewer' WHERE farm_id = ${farm} AND account_id = ${owner}`
  assert.equal(await deliverNextWebhook(notifications, unexpected), true)
  assert.equal(sends, 0, 'owner demotion suppresses queued channel delivery')

  console.log('alert rule enforcement and saved channel delivery checks passed')
} finally {
  await sql.end({ timeout: 3 })
}
