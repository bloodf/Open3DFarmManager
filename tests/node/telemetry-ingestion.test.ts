import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ingestTelemetry,
  type AgentIngestionContext,
} from '../../apps/farm/server/services/telemetry.ts'
import { MemoryTelemetryStore } from '../helpers/memory-telemetry-store.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { drainTelemetryOnce } from '../../packages/connector/src/cloud/drain.ts'
import { parseMoonrakerSnapshot } from '../../packages/connector/src/moonraker/parse.ts'
const id = '00000000-0000-4000-8000-000000000001'
const other = '00000000-0000-4000-8000-000000000002'
const context = { farmId: id, agentId: id, printerKeys: new Set(['synthetic']) }
const event = {
  eventId: id,
  queuedAt: 1000,
  kind: 'printer-state',
  state: {
    printerKey: 'synthetic',
    state: 'printing',
    progress: 0.5,
    observedAt: 1000,
  },
}
const body = JSON.stringify([event])

test('queue drains through actual ingestion validation after lost response without duplicate insertion', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'open3d-ingestion-'))
  let queue = new TelemetryQueue(directory, 1000)
  const store = new MemoryTelemetryStore()
  try {
    const raw = readFileSync(
      new URL('../fixtures/moonraker/printing.json', import.meta.url),
      'utf8',
    )
    queue.enqueue(
      parseMoonrakerSnapshot(raw, { printerKey: 'synthetic', observedAt: 1000 })
        .printer,
      1000,
    )
    const first = await drainTelemetryOnce(
      queue,
      async (body) => {
        assert.equal((await ingestTelemetry(body, context, store)).ok, true)
        throw new Error('Synthetic lost response')
      },
      () => 1000,
      new AbortController().signal,
    )
    assert.equal(first.status, 'retained')
    assert.equal(store.size, 1)
    queue.close()
    queue = new TelemetryQueue(directory, 1001)
    const second = await drainTelemetryOnce(
      queue,
      async (body) => {
        const result = await ingestTelemetry(body, context, store)
        if (!result.ok) throw new Error(result.reason)
        return result.acceptedEventIds
      },
      () => 1001,
      new AbortController().signal,
    )
    assert.equal(second.status, 'delivered')
    assert.equal(store.size, 1)
    assert.equal(queue.depth, 0)
  } finally {
    queue.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
test('missing trusted context and unauthorized printer never reach storage', async () => {
  let calls = 0
  const store = {
    commitBatch: async () => {
      calls++
      return 'committed' as const
    },
  }
  for (const invalid of [null, {}, { ...context, printerKeys: ['synthetic'] }])
    assert.deepEqual(
      await ingestTelemetry(body, invalid as AgentIngestionContext, store),
      { ok: false, reason: 'unauthorized' },
    )
  assert.deepEqual(
    await ingestTelemetry(
      body,
      { ...context, printerKeys: new Set(['other']) },
      store,
    ),
    { ok: false, reason: 'forbidden-printer' },
  )
  assert.equal(calls, 0)
})
test('commands, extra scope, duplicate keys, IDs, oversized and malformed batches never reach storage', async () => {
  let calls = 0
  const store = {
    commitBatch: async () => {
      calls++
      return 'committed' as const
    },
  }
  for (const invalid of [
    '[]',
    '{}',
    'x'.repeat(65537),
    body.replace('"kind":', '"kind":"printer-state","kind":'),
    JSON.stringify([event, event]),
    JSON.stringify(Array.from({ length: 101 }, () => event)),
    JSON.stringify([{ ...event, action: 'pause' }]),
    JSON.stringify([{ ...event, farmId: other }]),
    JSON.stringify([{ ...event, kind: 'command' }]),
    JSON.stringify([{ ...event, eventId: 'invalid' }]),
  ])
    assert.deepEqual(await ingestTelemetry(invalid, context, store), {
      ok: false,
      reason: 'invalid-batch',
    })
  assert.equal(calls, 0)
})
test('conflicting event-ID reuse rejects the whole batch; identity scope isolates tenants', async () => {
  const store = new MemoryTelemetryStore()
  assert.equal((await ingestTelemetry(body, context, store)).ok, true)
  const conflict = { ...event, state: { ...event.state, progress: 0.8 } }
  const mixed = JSON.stringify([{ ...event, eventId: other }, conflict])
  assert.deepEqual(await ingestTelemetry(mixed, context, store), {
    ok: false,
    reason: 'conflict',
  })
  assert.equal(store.size, 1)
  assert.equal(
    (await ingestTelemetry(body, { ...context, farmId: other }, store)).ok,
    true,
  )
  assert.equal(
    (await ingestTelemetry(body, { ...context, agentId: other }, store)).ok,
    true,
  )
  assert.equal(store.size, 3)
})
test('failed transaction or invalid adapter outcome never confirms acceptance', async () => {
  const store = new MemoryTelemetryStore()
  store.failBeforeCommit = true
  assert.deepEqual(await ingestTelemetry(body, context, store), {
    ok: false,
    reason: 'storage-unavailable',
  })
  assert.equal(store.size, 0)
  assert.deepEqual(
    await ingestTelemetry(body, context, {
      commitBatch: async () => 'unexpected' as never,
    }),
    { ok: false, reason: 'storage-unavailable' },
  )
  store.failBeforeCommit = false
  assert.equal((await ingestTelemetry(body, context, store)).ok, true)
})
test('acceptance waits for transaction completion', async () => {
  let commit!: () => void
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const completion = new Promise<void>((resolve) => {
    commit = resolve
  })
  let finished = false
  const pending = ingestTelemetry(body, context, {
    commitBatch: async () => {
      started()
      await completion
      return 'committed'
    },
  }).then((result) => {
    finished = true
    return result
  })
  await ready
  assert.equal(finished, false)
  commit()
  assert.deepEqual(await pending, { ok: true, acceptedEventIds: [id] })
})

test('maximum record-count batch is accepted within parser bounds', async () => {
  const records = Array.from({ length: 100 }, (_, index) => ({
    ...event,
    eventId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
  }))
  const store = new MemoryTelemetryStore()
  const result = await ingestTelemetry(JSON.stringify(records), context, store)
  assert.equal(result.ok, true)
  assert.equal(store.size, 100)
})
