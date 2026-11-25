import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { Sql } from 'postgres'
import { TelemetryBatch } from '../../packages/farm-protocol/src/telemetry.ts'
import { drainTelemetryOnce } from '../../packages/connector/src/cloud/drain.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { openScopedTelemetryQueue } from '../../packages/connector/src/runtime/queue-scope.ts'
import {
  IntegrationActionsService,
  type IntegrationActionsStore,
} from '../../apps/farm/server/services/integration-actions.ts'
import { PostgresIntegrationActions } from '../../apps/farm/server/storage/integration-actions-postgres.ts'
import { OBSERVATION_FRESH_MS } from '../../apps/farm/server/utils/integration-telemetry.ts'

function temporary(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'rv-921-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('API actions follow the browser freshness rule for advertised controls', async () => {
  const farmId = '11111111-1111-4111-8111-111111111111'
  const printerId = '22222222-2222-4222-8222-222222222222'
  const now = 10_000_000
  let row = {}
  const targets = new PostgresIntegrationActions((async () => [
    row,
  ]) as unknown as Sql)
  const reached: string[] = []
  const store: IntegrationActionsStore = {
    target: (id) => targets.target(id),
    existing: async () => null,
    // Reaching `create` means the advertised controls admitted the action.
    create: async (action) => {
      reached.push(action.action.action)
      return { kind: 'refused' }
    },
    get: async () => null,
  }
  const service = new IntegrationActionsService({
    store,
    envelopes: {} as never,
  })
  const scopes: ('control:basic' | 'control:extended')[] = [
    'control:basic',
    'control:extended',
  ]
  const principal = {
    appId: '33333333-3333-4333-8333-333333333333',
    scopes,
    grants: [
      {
        id: '44444444-4444-4444-8444-444444444444',
        appId: '33333333-3333-4333-8333-333333333333',
        farmId,
        printerAssignmentId: printerId,
        scopes,
        requiresApproval: false,
        createdAt: 1,
        disabledAt: null,
        disabledReason: null,
      },
    ],
  }
  const requests = [
    { action: 'pause', args: {} },
    { action: 'resume', args: {} },
    {
      action: 'set_temperature',
      args: { heater: 'extruder', targetCelsius: 200 },
    },
  ]
  async function admitted(
    ageAtSendMs: number | null,
    receivedAt: number | null,
  ) {
    row = {
      farmId,
      agentId: '55555555-5555-4555-8555-555555555555',
      controls: ['pause', 'resume', 'set_temperature'],
      observedAt: now,
      receivedAt,
      ageAtSendMs,
      now,
    }
    reached.length = 0
    for (const request of requests)
      await service.submit(
        principal,
        printerId,
        `key-${request.action}`,
        request,
      )
    return [...reached]
  }
  assert.deepEqual(await admitted(0, now), [
    'pause',
    'resume',
    'set_temperature',
  ])
  assert.deepEqual(await admitted(null, now), ['pause'])
  assert.deepEqual(await admitted(OBSERVATION_FRESH_MS + 1, now), [])
  assert.deepEqual(await admitted(0, now - OBSERVATION_FRESH_MS - 1), [])
  assert.deepEqual(await admitted(0, null), [])
})

test('an observation later than its enqueue time is sent as stale', async (t) => {
  const queuedAt = 1_000
  const queue = new TelemetryQueue(temporary(t), queuedAt)
  queue.enqueue(
    {
      printerKey: 'simulator',
      state: 'printing',
      progress: 0.5,
      observedAt: queuedAt + 10,
      controls: ['pause'],
    },
    queuedAt,
  )
  queue.enqueueInventory(
    { observedAt: queuedAt + 10, stale: false, total: 0, spools: [] },
    queuedAt,
  )
  const result = await drainTelemetryOnce(
    queue,
    async (body) => {
      const records = TelemetryBatch.parse(JSON.parse(body))
      assert.equal(records.length, 2)
      for (const record of records) {
        assert.ok(
          record.kind === 'printer-state' ||
            record.kind === 'inventory-snapshot',
        )
        assert.ok(record.ageAtSendMs! > OBSERVATION_FRESH_MS)
      }
      return records.map((record) => record.eventId)
    },
    () => queuedAt + 1,
    new AbortController().signal,
  )
  assert.equal(result.status, 'delivered')
  queue.close()
})

test('a backward clock step across a restart keeps queued safety telemetry', async (t) => {
  const dataDirectory = temporary(t)
  const open = (now: number) =>
    openScopedTelemetryQueue({
      dataDirectory,
      config: { assignments: [] } as never,
      credential: {
        farm_id: 'farm',
        agent_id: 'agent',
        expectedFingerprint: 'fingerprint',
      } as never,
      now,
    })
  const queuedAt = 10_000
  let queue = open(queuedAt)
  const transition = queue.enqueueTransition(
    {
      printerKey: 'simulator',
      from: 'printing',
      to: 'error',
      observedAt: queuedAt,
    },
    queuedAt,
  )
  const state = queue.enqueue(
    {
      printerKey: 'simulator',
      state: 'error',
      progress: 0.5,
      observedAt: queuedAt,
    },
    queuedAt,
  )
  queue.close()
  const log = join(dataDirectory, 'telemetry', 'telemetry.jsonl')
  const before = readFileSync(log, 'utf8')

  // The Connector refuses to start, leaving the log intact and unlocked.
  assert.throws(() => open(queuedAt - 1), /Queue clock regressed/)
  assert.equal(readFileSync(log, 'utf8'), before)
  assert.equal(
    existsSync(join(dataDirectory, 'telemetry', 'telemetry.lock')),
    false,
  )

  // A later restart, once the clock has caught up, delivers everything.
  queue = open(queuedAt)
  assert.equal(queue.depth, 2)
  const delivered: string[] = []
  const result = await drainTelemetryOnce(
    queue,
    async (body) => {
      const ids = TelemetryBatch.parse(JSON.parse(body)).map(
        (record) => record.eventId,
      )
      delivered.push(...ids)
      return ids
    },
    () => queuedAt,
    new AbortController().signal,
  )
  assert.equal(result.status, 'delivered')
  assert.deepEqual(delivered, [transition.eventId, state.eventId])
  queue.close()
})
