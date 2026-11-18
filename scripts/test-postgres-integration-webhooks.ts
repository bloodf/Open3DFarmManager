// Run only against the isolated PostgreSQL fixture allocated by test-postgres.ts.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { PostgresWebhooks } from '../apps/farm/server/storage/webhook-postgres.ts'
import { deliverNextWebhook } from '../apps/farm/server/services/webhook-worker.ts'

const port = Number(process.env.WEBHOOKS_SYNTHETIC_TEST_PORT)
if (
  process.argv.length !== 2 ||
  process.env.WEBHOOKS_SYNTHETIC_TEST_DISPOSABLE !== 'yes' ||
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535
)
  throw new Error('Explicit disposable loopback PostgreSQL port required')

const owner = 'webhook_owner_' + randomUUID()
const farm = randomUUID()
const app = randomUUID()
const otherApp = randomUUID()
const grant = randomUUID()
const role = 'webhook_fixture_' + randomUUID().replaceAll('-', '')
const options = {
  host: '127.0.0.1',
  port,
  database: 'fixture',
  password: '',
  connect_timeout: 3,
}
const admin = postgres({ ...options, username: 'fixture' })
const runtime = postgres({ ...options, username: role })
const store = new PostgresWebhooks(runtime)
try {
  await admin`CREATE ROLE ${admin(role)} LOGIN IN ROLE farm_integration_apps`
  await admin`INSERT INTO farm.session_accounts (id) VALUES (${owner})`
  await admin`INSERT INTO farm.farms (id) VALUES (${farm})`
  await admin`INSERT INTO farm.integration_apps (id, farm_id, name, sandbox, created_at, created_by)
    VALUES (${app}, ${farm}, 'webhooks', false, 1, ${owner}), (${otherApp}, ${farm}, 'other', false, 1, ${owner})`
  const printers = []
  for (const key of ['first', 'second']) {
    const agent = randomUUID()
    const printer = randomUUID()
    await admin`INSERT INTO farm.connector_enrollments (agent_id, farm_id, public_key_spki, fingerprint)
      VALUES (${agent}, ${farm}, ${'k'.repeat(59)}, ${key.padEnd(50, 'f')})`
    await admin`UPDATE farm.connector_enrollments SET status = 'approved' WHERE agent_id = ${agent}`
    await admin`INSERT INTO farm.printer_assignments (id, farm_id, agent_id, printer_key, created_at, created_by)
      VALUES (${printer}, ${farm}, ${agent}, ${key}, 1, ${owner})`
    printers.push({ agent, printer, key })
  }
  const [allowed, denied] = printers
  assert.ok(allowed && denied)
  await admin`INSERT INTO farm.integration_app_grants (id, app_id, farm_id, printer_assignment_id, scopes, created_at, created_by)
    VALUES (${grant}, ${app}, ${farm}, ${allowed.printer}, ARRAY['events:subscribe', 'jobs:start', 'control:basic'], 1, ${owner})`
  const input = {
    url: 'https://8.8.8.8/webhooks',
    events: [
      'job.ended',
      'printer.state_changed',
      'job.status_changed',
      'action.status_changed',
    ],
  }
  assert.equal(await store.create(otherApp, input), 'insufficient-scope')
  const subscription = await store.create(app, input)
  assert.ok(typeof subscription === 'object')
  assert.equal((await store.list(app, null, 1)).data[0]?.id, subscription.id)
  assert.ok(
    !Object.hasOwn((await store.list(app, null, 1)).data[0]!, 'signingSecret'),
  )
  assert.equal(await store.queueTest(otherApp, subscription.id), null)
  assert.equal(await store.delete(otherApp, subscription.id), false)

  const jobEnded = ({ agent, key }: typeof allowed, endedAt: number) => admin`
    INSERT INTO farm.job_history (farm_id, agent_id, printer_key, outcome, ended_at)
    VALUES (${farm}, ${agent}, ${key}, 'completed', ${endedAt})`
  await jobEnded(denied, 10)
  await assert.rejects(
    admin.begin(async (tx) => {
      await tx`INSERT INTO farm.job_history (farm_id, agent_id, printer_key, outcome, ended_at)
      VALUES (${farm}, ${allowed.agent}, ${allowed.key}, 'completed', 10)`
      assert.equal(
        (await tx`SELECT event_id FROM farm.integration_webhook_outbox`).length,
        1,
      )
      throw new Error('rollback')
    }),
    /rollback/,
  )
  assert.equal(await store.claim(), undefined)
  await jobEnded(allowed, 10)

  const attempts: string[] = []
  const fail = async ({
    eventId,
    body,
  }: NonNullable<Awaited<ReturnType<typeof store.claim>>>) => {
    const event = JSON.parse(body)
    assert.equal(event.id, eventId)
    assert.equal(event.type, 'job.ended')
    assert.equal(event.data.printerId, allowed.printer)
    attempts.push(eventId)
    return false
  }
  assert.equal(await deliverNextWebhook(store, fail), true)
  assert.equal(await deliverNextWebhook(store, fail), false)
  const [queued] =
    await admin`SELECT extract(epoch FROM (next_at - clock_timestamp()))::int AS delay
    FROM farm.integration_webhook_outbox`
  assert.ok(queued && queued.delay >= 8 && queued.delay <= 10)
  await admin`UPDATE farm.integration_webhook_outbox SET next_at = clock_timestamp()`
  assert.equal(await deliverNextWebhook(store, fail), true)
  assert.equal(attempts.length, 2)
  assert.equal(attempts[0], attempts[1])
  await admin`UPDATE farm.integration_webhook_outbox SET next_at = clock_timestamp(), expires_at = clock_timestamp()`
  let unexpectedSends = 0
  const unexpected = async () => {
    unexpectedSends++
    return true
  }
  assert.equal(await deliverNextWebhook(store, unexpected), true)
  assert.equal(unexpectedSends, 0)
  assert.equal(
    (await admin`SELECT status FROM farm.integration_webhook_outbox`)[0]
      ?.status,
    'dead',
  )

  await admin`INSERT INTO farm.printer_latest_state (farm_id, agent_id, printer_key, observed_at, state)
    VALUES (${farm}, ${allowed.agent}, ${allowed.key}, 11, '{"state":"printing","progress":0.5}')`
  await admin`UPDATE farm.printer_latest_state SET state = '{"state":"printing","progress":0.7}'`
  assert.equal(
    (
      await admin`SELECT body FROM farm.integration_webhook_outbox WHERE status = 'pending'`
    ).length,
    1,
  )

  const job = randomUUID()
  const action = randomUUID()
  await admin`INSERT INTO farm.integration_jobs (id, app_id, grant_id, farm_id, printer_assignment_id,
    idempotency_key, request_hash, file_url, sha256, size_bytes, display_name, status, created_at, updated_at)
    VALUES (${job}, ${app}, ${grant}, ${farm}, ${allowed.printer}, 'job', ${'a'.repeat(64)},
      'https://files.example/a.gcode', ${'b'.repeat(64)}, 50, 'a.gcode', 'submitted', 12, 12)`
  await admin`INSERT INTO farm.integration_actions (id, app_id, grant_id, farm_id, printer_assignment_id,
    idempotency_key, request_hash, action, required_scope, status, created_at, updated_at)
    VALUES (${action}, ${app}, ${grant}, ${farm}, ${allowed.printer}, 'action', ${'a'.repeat(64)},
      '{"action":"pause","args":{}}', 'control:basic', 'submitted', 12, 12)`
  const statuses =
    await admin`SELECT body->>'type' AS type, body#>>'{data,status}' AS status
    FROM farm.integration_webhook_outbox WHERE body->>'type' IN ('job.status_changed', 'action.status_changed') ORDER BY type`
  assert.deepEqual(
    statuses.map(({ type, status }) => [type, status]),
    [
      ['action.status_changed', 'queued'],
      ['job.status_changed', 'queued'],
    ],
  )

  const cmd = randomUUID()
  await admin`INSERT INTO farm.integration_envelopes (cmd_id, app_id, grant_id, farm_id, agent_id,
    printer_assignment_id, kind, resource_id, required_scope, nonce, wire, issued_at, expires_at,
    created_at, updated_at)
    VALUES (${cmd}, ${app}, ${grant}, ${farm}, ${allowed.agent}, ${allowed.printer}, 'action', ${action},
      'control:basic', ${'c'.repeat(22)}, 'synthetic fixture', 12, 1012, 12, 12)`
  await admin`UPDATE farm.integration_envelopes SET status = 'sending', updated_at = 13 WHERE cmd_id = ${cmd}`
  await admin`UPDATE farm.integration_envelopes SET status = 'refused', refusal_code = 'not-ready',
    result_detail = 'Sintético', updated_at = 14 WHERE cmd_id = ${cmd}`
  const refusal = await admin`SELECT body->'data'->'refusal' AS refusal
    FROM farm.integration_webhook_outbox WHERE body#>>'{data,status}' = 'refused'`
  assert.deepEqual(
    refusal.map((row) => row.refusal),
    [{ code: 'not-ready', detail: 'Sintético' }],
  )

  const success = await store.queueTest(app, subscription.id)
  assert.ok(success)
  const deliveredIds: string[] = []
  while (
    await deliverNextWebhook(store, async ({ eventId }) => {
      deliveredIds.push(eventId)
      return true
    })
  ) {
    // Drain via the normal claim and completion path.
  }
  assert.ok(deliveredIds.includes(success.eventId))
  assert.equal(
    (
      await admin`SELECT status FROM farm.integration_webhook_outbox WHERE event_id = ${success.eventId}`
    )[0]?.status,
    'delivered',
  )

  const queuedTest = await store.queueTest(app, subscription.id)
  assert.ok(queuedTest)
  await admin`UPDATE farm.integration_app_grants SET disabled_at = 15, disabled_reason = 'revoked' WHERE id = ${grant}`
  while (await deliverNextWebhook(store, unexpected)) {
    // Drain the remaining pending deliveries.
  }
  assert.equal(unexpectedSends, 0)
  assert.equal(
    (
      await admin`SELECT status FROM farm.integration_webhook_outbox WHERE event_id = ${queuedTest.eventId}`
    )[0]?.status,
    'dead',
  )
  assert.equal(await store.delete(app, subscription.id), true)
  assert.equal(
    (await admin`SELECT event_id FROM farm.integration_webhook_outbox`).length,
    0,
  )
  console.log(
    JSON.stringify({
      result: 'passed',
      checks: [
        'atomic capture',
        'grant filtering and revocation',
        'stable event across retries and expiry',
        'printer state deduplication',
        'command events',
        'subscription isolation and deletion',
      ],
    }),
  )
} finally {
  await runtime.end({ timeout: 3 })
  await admin`DROP ROLE IF EXISTS ${admin(role)}`
  await admin.end({ timeout: 3 })
}
