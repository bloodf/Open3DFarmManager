import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import {
  parseWebhookUrl,
  resolveWebhookTarget,
  webhookHeaders,
  webhookRetrySeconds,
} from '../../apps/farm/server/services/webhook-delivery.ts'
import { webhookRequest } from '../../apps/farm/server/services/webhook-http.ts'
import { deliverNextWebhook } from '../../apps/farm/server/services/webhook-worker.ts'
import type { IntegrationPrincipal } from '../../apps/farm/server/utils/integration-auth.ts'

test('webhook signatures cover the attempt timestamp and exact body with stable event IDs', () => {
  const id = randomUUID()
  const body = JSON.stringify({
    id,
    type: 'webhook.test',
    data: { message: 'Olá' },
  })
  for (const millis of [7000000, 7010000]) {
    const signed = webhookHeaders(id, 'test signing secret', body, millis)
    assert.equal(signed['OpenFarm-Event-Id'], id)
    assert.equal(signed['OpenFarm-Timestamp'], String(millis / 1000))
    assert.equal(
      signed['OpenFarm-Signature'],
      'v1=' +
        createHmac('sha256', 'test signing secret')
          .update(Buffer.from(`${millis / 1000}.${body}`))
          .digest('hex'),
    )
    assert.equal(signed['content-length'], Buffer.byteLength(body))
  }
})

test('production targets refuse nonpublic literals and mixed DNS answers', async () => {
  for (const host of [
    '127.0.0.1',
    '2130706433',
    '10.0.0.1',
    '172.31.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '[::1]',
    '[::ffff:127.0.0.1]',
    '[fc00::1]',
    '[fe80::1]',
  ]) {
    const url = parseWebhookUrl('https://' + host)
    assert.ok(url)
    assert.equal(await resolveWebhookTarget(url, false), null, host)
    assert.ok(await resolveWebhookTarget(url, true), host)
  }
  const url = new URL('https://webhook.example.invalid')
  const resolve = async () => [
    { address: '8.8.8.8', family: 4 },
    { address: '192.168.0.1', family: 4 },
  ]
  assert.equal(await resolveWebhookTarget(url, false, resolve), null)
  assert.equal(
    (await resolveWebhookTarget(url, true, resolve))?.address,
    '8.8.8.8',
  )
  assert.equal(parseWebhookUrl('http://8.8.8.8'), null)
  assert.equal(parseWebhookUrl('https://username:password@8.8.8.8'), null)
})

test('creation requires an event grant and sandbox status controls private destinations', async () => {
  const url = 'https://127.0.0.1:8123/receive'
  const request = () =>
    new Request('https://farm.example/api/integrations/v1/webhooks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, events: ['job.ended'] }),
    })
  const appId = randomUUID()
  const id = randomUUID()
  const scopes = ['events:subscribe'] as const
  const grant = {
    id: randomUUID(),
    farmId: randomUUID(),
    appId,
    createdAt: 1,
    disabledAt: null,
    disabledReason: null,
    scopes: [...scopes],
    printerAssignmentId: null,
    requiresApproval: false,
  }
  const principal: IntegrationPrincipal = { appId, scopes, grants: [grant] }
  const signingSecret = 'test-signing-secret'.repeat(3)
  let sandbox = false
  const store: Parameters<typeof webhookRequest>[2] = {
    async sandbox() {
      return sandbox
    },
    async create(owner, input) {
      assert.equal(owner, appId)
      return { id, ...input, createdAt: 100, signingSecret }
    },
    async list() {
      return {
        data: [{ id, url, events: ['job.ended'], createdAt: 100 }],
        nextCursor: null,
      }
    },
    async delete() {
      return false
    },
    async queueTest() {
      return null
    },
  }

  const forbidden = await webhookRequest(
    request(),
    { ...principal, grants: [] },
    store,
    {},
  )
  assert.equal(forbidden.status, 403)
  const unsafe = await webhookRequest(request(), principal, store, {})
  assert.equal(unsafe.status, 422)
  assert.equal((await unsafe.json()).code, 'unsafe-target')
  sandbox = true
  const created = await webhookRequest(request(), principal, store, {
    'RateLimit-Limit': '10',
  })
  assert.equal(created.status, 201)
  assert.equal(created.headers.get('cache-control'), 'no-store')
  assert.equal(
    created.headers.get('location'),
    '/api/integrations/v1/webhooks/' + id,
  )
  assert.equal(created.headers.get('ratelimit-limit'), '10')
  assert.equal((await created.json()).signingSecret, signingSecret)
  const listed = await webhookRequest(
    new Request(request().url),
    principal,
    store,
    {},
  )
  assert.deepEqual(await listed.json(), {
    data: [{ id, url, events: ['job.ended'], createdAt: 100 }],
    nextCursor: null,
  })
})

test('a failed delivery stays pending and the same event is sent again until it expires', async () => {
  const delivery = {
    subscriptionId: randomUUID(),
    eventId: randomUUID(),
    sandbox: false,
    secret: 'key',
    body: '{}',
    url: 'https://8.8.8.8',
    attempts: 0,
  }
  const ids: string[] = []
  const outcomes: string[] = []
  const store: Parameters<typeof deliverNextWebhook>[0] = {
    async claim() {
      return { ...delivery, attempts: ++delivery.attempts }
    },
    async eligible(event) {
      return event.attempts <= 2
    },
    async finish(_, outcome) {
      outcomes.push(outcome)
    },
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    await deliverNextWebhook(store, async ({ eventId }) => {
      ids.push(eventId)
      return false
    })
  }
  assert.deepEqual(ids, [delivery.eventId, delivery.eventId])
  assert.deepEqual(outcomes, ['pending', 'pending', 'dead'])
  assert.deepEqual([1, 2, 3, 30].map(webhookRetrySeconds), [10, 20, 40, 3600])
})
