import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parse } from 'yaml'
import type { IntegrationGrant } from '../../apps/farm/server/services/integration-apps.ts'
import type {
  IntegrationPrincipal,
  IntegrationPrinterRow,
} from '../../apps/farm/server/utils/integration-auth.ts'
import {
  getIntegrationPrinterStatus,
  listIntegrationPrinters,
  type IntegrationPrinterReader,
} from '../../apps/farm/server/utils/integration-printers.ts'

const farmA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const farmB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const printerA = 'aaaaaaaa-0000-4000-8000-000000000001'
const printerB = 'bbbbbbbb-0000-4000-8000-000000000002'

function grant(
  farmId: string,
  printerAssignmentId: string | null,
): IntegrationGrant {
  return {
    id: 'grant-' + (printerAssignmentId ?? farmId),
    appId: 'app',
    farmId,
    printerAssignmentId,
    scopes: ['printers:read'],
    requiresApproval: false,
    createdAt: 1,
    disabledAt: null,
    disabledReason: null,
  }
}

function row(
  overrides: Partial<IntegrationPrinterRow> = {},
): IntegrationPrinterRow {
  return {
    id: printerA,
    farmId: farmA,
    printerKey: 'printer-a',
    sandbox: false,
    state: {
      printerKey: 'printer-a',
      state: 'printing',
      progress: 0.5,
      observedAt: 1234,
      identity: { vendor: 'Example', model: 'Model 1' },
      controls: ['pause'],
      filename: 'part.gcode',
      estimatedRemainingSeconds: 60,
      toolTemperatureCelsius: 210,
      bedTemperatureCelsius: 60,
    },
    observedAt: 1234,
    ...overrides,
  }
}

function reader(rows: IntegrationPrinterRow[]) {
  const calls: Parameters<IntegrationPrinterReader['readPrinters']>[0][] = []
  const store: IntegrationPrinterReader = {
    async readPrinters(input) {
      calls.push(input)
      return rows
        .filter(
          (entry) =>
            input.farmWideFarmIds.includes(entry.farmId) ||
            input.assignmentIds.includes(entry.id),
        )
        .filter((entry) => !input.farmId || input.farmId === entry.farmId)
        .filter((entry) => !input.afterId || entry.id > input.afterId)
        .slice(0, input.limit)
    },
    async readPrinter(id) {
      return rows.find((entry) => entry.id === id) ?? null
    },
  }
  return { store, calls }
}

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

test('printer list is grant filtered, paginated and matches the OpenAPI schema', async () => {
  const principal: IntegrationPrincipal = {
    appId: 'app',
    scopes: ['printers:read'],
    grants: [grant(farmA, printerA)],
  }
  const { store, calls } = reader([
    row(),
    row({ id: printerB, farmId: farmB, printerKey: 'printer-b' }),
  ])
  const result = await listIntegrationPrinters(
    principal,
    store,
    new URLSearchParams({ limit: '1' }),
  )
  assert.ok(!('error' in result))
  assert.deepEqual(result.data, [
    {
      id: printerA,
      farmId: farmA,
      printerKey: 'printer-a',
      vendor: 'Example',
      model: 'Model 1',
      controls: ['pause'],
      sandbox: false,
    },
  ])
  assert.equal(result.nextCursor, null)
  assert.deepEqual(calls[0]?.assignmentIds, [printerA])
  assertMatchesSchema(result, spec.components.schemas.PrinterPage!)

  const widePrincipal: IntegrationPrincipal = {
    ...principal,
    grants: [grant(farmA, null)],
  }
  const secondRow = row({
    id: 'cccccccc-0000-4000-8000-000000000003',
    printerKey: 'printer-c',
  })
  const paged = reader([row(), secondRow])
  const firstPage = await listIntegrationPrinters(
    widePrincipal,
    paged.store,
    new URLSearchParams({ limit: '1' }),
  )
  assert.ok(!('error' in firstPage))
  assert.equal(typeof firstPage.nextCursor, 'string')
  const secondPage = await listIntegrationPrinters(
    widePrincipal,
    paged.store,
    new URLSearchParams({ limit: '1', cursor: firstPage.nextCursor! }),
  )
  assert.ok(!('error' in secondPage))
  assert.equal(secondPage.data[0]?.id, secondRow.id)
  assert.equal(secondPage.nextCursor, null)
  assert.equal(paged.calls[1]?.snapshotAt, paged.calls[0]?.snapshotAt)
})

test('status exposes projection values and reports absent or invalid state as unknown', async () => {
  const principal: IntegrationPrincipal = {
    appId: 'app',
    scopes: ['printers:read'],
    grants: [grant(farmA, null)],
  }
  const { store } = reader([
    row(),
    row({ id: printerB, state: null, observedAt: null }),
  ])
  const status = await getIntegrationPrinterStatus(principal, store, printerA)
  assert.ok(!('error' in status))
  assert.deepEqual(status, {
    printerId: printerA,
    farmId: farmA,
    printerKey: 'printer-a',
    state: 'printing',
    progress: 0.5,
    filename: 'part.gcode',
    estimatedRemainingSeconds: 60,
    temperatures: { toolCelsius: 210, bedCelsius: 60 },
    vendor: 'Example',
    model: 'Model 1',
    observedAt: 1234,
  })
  assertMatchesSchema(status, spec.components.schemas.PrinterStatus!)
  const unknown = await getIntegrationPrinterStatus(principal, store, printerB)
  assert.deepEqual(unknown, {
    printerId: printerB,
    farmId: farmA,
    printerKey: 'printer-a',
    state: 'unknown',
  })
  assertMatchesSchema(unknown, spec.components.schemas.PrinterStatus!)
})

test('printer status hides assignments outside the current grants', async () => {
  const principal: IntegrationPrincipal = {
    appId: 'app',
    scopes: ['printers:read'],
    grants: [grant(farmA, printerA)],
  }
  const { store } = reader([row({ id: printerB, farmId: farmA })])
  assert.deepEqual(
    await getIntegrationPrinterStatus(principal, store, printerB),
    { error: 'not-found' },
  )
})

test('list rejects invalid filters and cursor values', async () => {
  const principal: IntegrationPrincipal = {
    appId: 'app',
    scopes: ['printers:read'],
    grants: [grant(farmA, null)],
  }
  const { store } = reader([])
  assert.deepEqual(
    await listIntegrationPrinters(
      principal,
      store,
      new URLSearchParams('limit=101'),
    ),
    { error: 'invalid-request' },
  )
  assert.deepEqual(
    await listIntegrationPrinters(
      principal,
      store,
      new URLSearchParams('cursor=bad'),
    ),
    { error: 'invalid-request' },
  )
})
