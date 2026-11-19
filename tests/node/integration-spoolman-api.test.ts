import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHmac, randomUUID } from 'node:crypto'
import test from 'node:test'
import { parse } from 'yaml'
import { listIntegrationJobs } from '../../apps/farm/server/utils/integration-read.ts'
import { getIntegrationPrinterStatus } from '../../apps/farm/server/utils/integration-printers.ts'
import { webhookHeaders } from '../../apps/farm/server/services/webhook-delivery.ts'
import { deliverNextWebhook } from '../../apps/farm/server/services/webhook-worker.ts'
import type { IntegrationPrincipal } from '../../apps/farm/server/utils/integration-auth.ts'
const spec = parse(
  readFileSync(
    new URL('../../docs/api/openapi-v1.yaml', import.meta.url),
    'utf8',
  ),
) as { components: { schemas: Record<string, Record<string, unknown>> } }

function resolveRef(ref: string) {
  const parts = ref.replace(/^#\//, '').split('/')
  let value: unknown = spec
  for (const part of parts) value = (value as Record<string, unknown>)[part]
  return value as Record<string, unknown>
}

function assertMatchesSchema(
  value: unknown,
  schema: Record<string, unknown>,
  path = '$',
) {
  if (typeof schema.$ref === 'string')
    return assertMatchesSchema(value, resolveRef(schema.$ref), path)
  if (Array.isArray(schema.allOf)) {
    for (const part of schema.allOf)
      assertMatchesSchema(value, part as Record<string, unknown>, path)
  }
  const type = schema.type
  if (Array.isArray(type)) {
    assert.ok(
      type.some((entry) => typeMatches(value, entry as string)),
      `${path} type`,
    )
  } else if (typeof type === 'string') {
    assert.ok(typeMatches(value, type), `${path} type ${type}`)
  }
  if (Array.isArray(schema.required)) {
    assert.ok(value !== null && typeof value === 'object', `${path} object`)
    for (const key of schema.required as string[])
      assert.ok(key in value, `${path}.${key} required`)
  }
  if (schema.const !== undefined)
    assert.equal(value, schema.const, `${path} const`)
  if (schema.enum)
    assert.ok((schema.enum as unknown[]).includes(value), `${path} enum`)
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number')
      assert.ok(value.length >= schema.minLength, `${path} minLength`)
    if (typeof schema.maxLength === 'number')
      assert.ok(value.length <= schema.maxLength, `${path} maxLength`)
    if (typeof schema.pattern === 'string')
      assert.match(value, new RegExp(schema.pattern), path)
    if (schema.format === 'uuid')
      assert.match(
        value,
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      )
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number')
      assert.ok(value >= schema.minimum, `${path} minimum`)
    if (typeof schema.maximum === 'number')
      assert.ok(value <= schema.maximum, `${path} maximum`)
    if (schema.type === 'integer')
      assert.ok(Number.isInteger(value), `${path} integer`)
  }
  if (Array.isArray(value)) {
    if (typeof schema.maxItems === 'number')
      assert.ok(value.length <= schema.maxItems, `${path} maxItems`)
    if (schema.items)
      for (const [index, item] of value.entries())
        assertMatchesSchema(
          item,
          schema.items as Record<string, unknown>,
          `${path}[${index}]`,
        )
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const properties = (schema.properties ?? {}) as Record<
      string,
      Record<string, unknown>
    >
    if (schema.additionalProperties === false)
      for (const key of Object.keys(value))
        assert.ok(key in properties, `${path}.${key} additional property`)
    for (const [key, child] of Object.entries(properties)) {
      if (key in value)
        assertMatchesSchema(
          (value as Record<string, unknown>)[key],
          child,
          `${path}.${key}`,
        )
    }
  }
}

function typeMatches(value: unknown, type: string) {
  return type === 'null'
    ? value === null
    : type === 'array'
      ? Array.isArray(value)
      : type === 'integer'
        ? typeof value === 'number' && Number.isInteger(value)
        : type === 'object'
          ? value !== null && typeof value === 'object' && !Array.isArray(value)
          : typeof value === type
}

const farmId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const printerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const connectorId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const usage = [{ tool: 'external', grams: 12, millimetres: 1234 }]

test('printer status and jobs expose fields matching the contract', async () => {
  const principal: IntegrationPrincipal = {
    appId: 'app',
    scopes: ['printers:read'],
    grants: [
      {
        id: 'grant',
        appId: 'app',
        farmId,
        printerAssignmentId: null,
        scopes: ['printers:read'],
        requiresApproval: false,
        createdAt: 1,
        disabledAt: null,
        disabledReason: null,
      },
    ],
  }
  const status = await getIntegrationPrinterStatus(
    principal,
    {
      async readPrinter() {
        return {
          id: printerId,
          farmId,
          printerKey: 'p',
          sandbox: false,
          observedAt: 1234,
          state: {
            printerKey: 'p',
            state: 'printing',
            progress: 0.5,
            observedAt: 1234,
            materials: [
              { slot: 'external', materialType: 'PLA', remainingPercent: 70 },
            ],
          },
        }
      },
    },
    printerId,
  )
  assert.deepEqual('activeSpools' in status && status.activeSpools, [
    { slot: 'external', material: 'PLA', remainingPercent: 70 },
  ])
  assertMatchesSchema(status, spec.components.schemas.PrinterStatus!)
  let query = ''
  const sql = Object.assign(
    async (parts: TemplateStringsArray) => {
      query = parts.join('?')
      return [
        {
          id: '17',
          farmId,
          printerId,
          outcome: 'completed',
          filename: null,
          printDurationSeconds: null,
          totalDurationSeconds: null,
          filamentUsage: usage,
          endedAt: 1234,
        },
      ]
    },
    { array: (values: unknown[]) => values },
  )
  const page = await listIntegrationJobs(sql as never, {
    farmWideFarmIds: [farmId],
    assignmentIds: [],
    printerId: null,
    since: null,
    until: null,
    limit: 50,
    cursor: null,
  })
  assert.match(query, /h\.filament_usage/)
  assert.deepEqual(page.data[0]?.filamentUsage, usage)
  assertMatchesSchema(page.data[0], spec.components.schemas.JobHistoryEntry!)
})

test('event payloads follow the contract and share signed retry delivery', async () => {
  const events = [
    {
      type: 'job.ended',
      data: {
        id: '17',
        farmId,
        printerId,
        outcome: 'completed',
        endedAt: 1234,
        filamentUsage: usage,
      },
      schema: 'JobEndedEvent',
    },
    {
      type: 'inventory.changed',
      data: {
        farmId,
        connectorId,
        observedAt: 1234,
        stale: false,
        total: 1,
        spools: [
          {
            name: null,
            material: 'PLA',
            colorHex: null,
            remainingGrams: null,
            location: null,
            archived: false,
          },
        ],
      },
      schema: 'InventoryChangedEvent',
    },
  ]
  for (const { schema, ...event } of events) {
    const id = randomUUID()
    const body = JSON.stringify({ id, occurredAt: 1234, ...event })
    assertMatchesSchema(JSON.parse(body), spec.components.schemas[schema]!)
    const headers = webhookHeaders(id, 'secret', body, 5000)
    assert.equal(
      headers['OpenFarm-Signature'],
      'v1=' +
        createHmac('sha256', 'secret')
          .update('5.' + body)
          .digest('hex'),
    )
    const outcomes: string[] = []
    const delivery = {
      subscriptionId: randomUUID(),
      eventId: id,
      sandbox: false,
      secret: 'secret',
      body,
      url: 'https://example.com',
      attempts: 1,
    }
    const store = {
      async claim() {
        return delivery
      },
      async eligible() {
        return true
      },
      async finish(
        _delivery: typeof delivery,
        outcome: 'delivered' | 'dead' | 'pending',
      ) {
        outcomes.push(outcome)
      },
    }
    await deliverNextWebhook(store, async () => false)
    await deliverNextWebhook(store, async () => true)
    assert.deepEqual(outcomes, ['pending', 'delivered'])
  }
  const migration = readFileSync(
    new URL(
      '../../infra/db/migrations/0054_spoolman_webhook_events.up.sql',
      import.meta.url,
    ),
    'utf8',
  )
  assert.match(migration, /'filamentUsage', NEW\.filament_usage/)
  assert.match(migration, /'inventory.changed'/)
  assert.match(
    migration,
    /WHEN event_type = 'inventory.changed' THEN payload ELSE jsonb_strip_nulls\(payload\)/,
  )
  assert.match(
    migration,
    /integration_webhook_allowed\(w\.app_id, NEW\.farm_id, printer\)/,
  )
})
