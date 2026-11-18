import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parse } from 'yaml'
import { readFile } from 'node:fs/promises'
import {
  inventoryGrantFarms,
  jobGrantScope,
  listIntegrationInventory,
  listIntegrationJobs,
} from '../../apps/farm/server/utils/integration-read.ts'
import type { IntegrationPrincipal } from '../../apps/farm/server/utils/integration-auth.ts'

function mockSql(rows: unknown[]) {
  const calls: { text: string; values: unknown[] }[] = []
  const sql = Object.assign(
    async (parts: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: parts.join('?'), values })
      return rows
    },
    {
      array: (values: unknown[], type?: string) =>
        type === undefined ? { values } : { values, type },
    },
  )
  return { sql, calls }
}

test('inventory page returns validated latest snapshots and stable keyset cursor', async () => {
  const farmId = '11111111-1111-4111-8111-111111111111'
  const connectorId = '22222222-2222-4222-8222-222222222222'
  const fake = mockSql([
    {
      farmId,
      connectorId,
      observedAt: 1700000000000,
      snapshot: {
        observedAt: 1700000000000,
        stale: false,
        total: 1,
        spools: [],
      },
    },
    {
      farmId,
      connectorId: '33333333-3333-4333-8333-333333333333',
      observedAt: 1700000000001,
      snapshot: {
        observedAt: 1700000000001,
        stale: true,
        total: 0,
        spools: [],
      },
    },
  ])
  const page = await listIntegrationInventory(fake.sql as never, {
    farmIds: [farmId],
    limit: 1,
    cursor: null,
  })
  assert.deepEqual(page.data, [
    {
      farmId,
      connectorId,
      observedAt: 1700000000000,
      stale: false,
      total: 1,
      spools: [],
    },
  ])
  assert.ok(page.nextCursor)
  const cursor = JSON.parse(
    Buffer.from(page.nextCursor, 'base64url').toString(),
  )
  assert.deepEqual(cursor, { farmId, connectorId })
  assert.match(fake.calls[0]!.text, /farm_id = ANY/)
  await assert.rejects(() =>
    listIntegrationInventory(fake.sql as never, {
      farmIds: [farmId],
      limit: 1,
      cursor: 'garbage',
    }),
  )
})

test('job history query scopes printers, filters time and uses immutable keyset order', async () => {
  const farmId = '11111111-1111-4111-8111-111111111111'
  const printerId = '22222222-2222-4222-8222-222222222222'
  const fake = mockSql([
    {
      id: '17',
      farmId,
      printerId,
      outcome: 'completed',
      filename: 'part.gcode',
      printDurationSeconds: 10,
      totalDurationSeconds: 12,
      endedAt: 1700000000000,
    },
    {
      id: '16',
      farmId,
      printerId,
      outcome: 'failed',
      filename: null,
      printDurationSeconds: null,
      totalDurationSeconds: null,
      endedAt: 1699999999000,
    },
  ])
  const page = await listIntegrationJobs(fake.sql as never, {
    farmWideFarmIds: [],
    assignmentIds: [printerId],
    printerId,
    since: 1600000000000,
    until: null,
    limit: 1,
    cursor: null,
  })
  assert.deepEqual(page.data, [
    {
      id: '17',
      farmId,
      printerId,
      outcome: 'completed',
      filename: 'part.gcode',
      printDurationSeconds: 10,
      totalDurationSeconds: 12,
      endedAt: 1700000000000,
    },
  ])
  assert.ok(page.nextCursor)
  assert.deepEqual(
    JSON.parse(Buffer.from(page.nextCursor, 'base64url').toString()),
    {
      endedAt: 1700000000000,
      id: '17',
    },
  )
  const call = fake.calls[0]!
  assert.match(call.text, /p\.id = ANY/)
  assert.match(call.text, /h\.ended_at >=/)
  assert.match(call.text, /\(h\.ended_at, h\.id\) </)
  assert.match(call.text, /ORDER BY h\.ended_at DESC, h\.id DESC/)
  assert.deepEqual(call.values[0], { values: [] })
  assert.deepEqual(call.values[1], { values: [printerId] })
  await assert.rejects(() =>
    listIntegrationJobs(fake.sql as never, {
      farmWideFarmIds: [farmId],
      assignmentIds: [],
      printerId: null,
      since: null,
      until: null,
      limit: 10,
      cursor: 'garbage',
    }),
  )
})

test('inventory and job responses follow the published OpenAPI schemas', async () => {
  const spec = parse(
    await readFile(
      new URL('../../docs/api/openapi-v1.yaml', import.meta.url),
      'utf8',
    ),
  )
  const inventory = spec.components.schemas.InventorySnapshot
  const job = spec.components.schemas.JobHistoryEntry
  assert.deepEqual(inventory.required, [
    'farmId',
    'connectorId',
    'observedAt',
    'stale',
    'total',
    'spools',
  ])
  assert.deepEqual(job.required, [
    'id',
    'farmId',
    'printerId',
    'outcome',
    'endedAt',
  ])
  assert.equal(spec.paths['/inventory'].get.operationId, 'listInventory')
  assert.equal(spec.paths['/jobs'].get.operationId, 'listJobHistory')
})

test('grant scope excludes ungranted printers and printer-scoped inventory grants', () => {
  const farmId = '11111111-1111-4111-8111-111111111111'
  const allowedPrinter = '22222222-2222-4222-8222-222222222222'
  const hiddenPrinter = '33333333-3333-4333-8333-333333333333'
  const principal: IntegrationPrincipal = {
    appId: '44444444-4444-4444-8444-444444444444',
    scopes: ['inventory:read', 'jobs:read'],
    grants: [
      {
        id: '55555555-5555-4555-8555-555555555555',
        appId: '44444444-4444-4444-8444-444444444444',
        farmId,
        printerAssignmentId: allowedPrinter,
        scopes: ['jobs:read'],
        requiresApproval: false,
        createdAt: 0,
        disabledAt: null,
        disabledReason: null,
      },
      {
        id: '66666666-6666-4666-8666-666666666666',
        appId: '44444444-4444-4444-8444-444444444444',
        farmId,
        printerAssignmentId: hiddenPrinter,
        scopes: ['jobs:read'],
        requiresApproval: false,
        createdAt: 0,
        disabledAt: null,
        disabledReason: null,
      },
      {
        id: '77777777-7777-4777-8777-777777777777',
        appId: '44444444-4444-4444-8444-444444444444',
        farmId,
        printerAssignmentId: allowedPrinter,
        scopes: ['inventory:read'],
        requiresApproval: false,
        createdAt: 0,
        disabledAt: null,
        disabledReason: null,
      },
    ],
  }
  assert.deepEqual(inventoryGrantFarms(principal), [])
  assert.deepEqual(jobGrantScope(principal, farmId, allowedPrinter), {
    farmWideFarmIds: [],
    assignmentIds: [allowedPrinter],
  })
  assert.deepEqual(
    jobGrantScope(principal, farmId, '88888888-8888-4888-8888-888888888888'),
    {
      farmWideFarmIds: [],
      assignmentIds: [],
    },
  )
})
