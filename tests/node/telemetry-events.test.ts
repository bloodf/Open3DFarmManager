import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TelemetryBatch } from '@open3dfarmmanager/farm-protocol'
import { ingestTelemetry } from '../../apps/farm/server/services/telemetry.ts'
import { MemoryTelemetryStore } from '../helpers/memory-telemetry-store.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { drainTelemetryOnce } from '../../packages/connector/src/cloud/drain.ts'

const id = '00000000-0000-4000-8000-000000000001'
const context = { farmId: id, agentId: id, printerKeys: new Set(['p1']) }
const state = {
  printerKey: 'p1',
  state: 'error' as const,
  progress: 0,
  observedAt: 1000,
}
const transition = {
  printerKey: 'p1',
  from: 'printing' as const,
  to: 'error' as const,
  observedAt: 1000,
}

test('transition events share the queue, survive restart and drain idempotently with state snapshots', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'open3d-events-'))
  let queue = new TelemetryQueue(dir, 1000)
  const store = new MemoryTelemetryStore()
  try {
    const a = queue.enqueueTransition(transition, 1000).eventId
    const b = queue.enqueue(state, 1000).eventId
    queue.close()
    queue = new TelemetryQueue(dir, 1001)
    assert.deepEqual(
      queue.batch(1001).records.map((r) => [r.eventId, r.kind]),
      [
        [a, 'printer-transition'],
        [b, 'printer-state'],
      ],
    )
    const lost = await drainTelemetryOnce(
      queue,
      async (body) => {
        assert.equal((await ingestTelemetry(body, context, store)).ok, true)
        throw new Error('lost response')
      },
      () => 1001,
      new AbortController().signal,
    )
    assert.equal(lost.status, 'retained')
    assert.equal(store.size, 2)
    const done = await drainTelemetryOnce(
      queue,
      async (body) => {
        const result = await ingestTelemetry(body, context, store)
        if (!result.ok) throw new Error(result.reason)
        return result.acceptedEventIds
      },
      () => 1002,
      new AbortController().signal,
    )
    assert.equal(done.status, 'delivered')
    assert.equal(store.size, 2)
    assert.equal(queue.depth, 0)
  } finally {
    queue.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('invalid transitions are rejected by schema, queue and ingestion', async () => {
  const base = { eventId: id, queuedAt: 1, kind: 'printer-transition' }
  for (const bad of [
    { ...transition, to: 'printing' },
    { ...transition, extra: 1 },
    { ...transition, to: 'exploded' },
    { ...transition, printerKey: '' },
  ])
    assert.equal(
      TelemetryBatch.safeParse([{ ...base, transition: bad }]).success,
      false,
    )
  assert.equal(
    TelemetryBatch.safeParse([{ ...base, transition, state }]).success,
    false,
  )
  const dir = mkdtempSync(join(tmpdir(), 'open3d-events-'))
  const queue = new TelemetryQueue(dir, 1000)
  try {
    assert.throws(() =>
      queue.enqueueTransition({ ...transition, to: 'printing' }, 1000),
    )
    assert.equal(queue.depth, 0)
  } finally {
    queue.close()
    rmSync(dir, { recursive: true, force: true })
  }
  const store = new MemoryTelemetryStore()
  const body = JSON.stringify([{ ...base, transition }])
  assert.deepEqual(
    await ingestTelemetry(
      body,
      { ...context, printerKeys: new Set(['other']) },
      store,
    ),
    { ok: false, reason: 'forbidden-printer' },
  )
  assert.equal(store.size, 0)
})

test('a corrupt transition record on disk is rejected on recovery, never delivered', () => {
  const dir = mkdtempSync(join(tmpdir(), 'open3d-events-'))
  let queue = new TelemetryQueue(dir, 1000)
  try {
    queue.enqueueTransition(transition, 1000)
    queue.close()
    appendFileSync(
      join(dir, 'telemetry.jsonl'),
      JSON.stringify({
        eventId: '00000000-0000-4000-8000-000000000009',
        queuedAt: 1,
        kind: 'printer-transition',
        transition: { ...transition, to: 'printing' },
      }) + '\n',
    )
    assert.throws(() => new TelemetryQueue(dir, 1001), /No-op transition/)
  } finally {
    queue.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
