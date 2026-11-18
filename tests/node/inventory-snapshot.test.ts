import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SpoolInventory,
  TelemetryBatch,
} from '@open3dfarmmanager/farm-protocol'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { drainTelemetryOnce } from '../../packages/connector/src/cloud/drain.ts'
import { ingestTelemetry } from '../../apps/farm/server/services/telemetry.ts'
import { MemoryTelemetryStore } from '../helpers/memory-telemetry-store.ts'

const id = '00000000-0000-4000-8000-000000000001'
const snapshot = (observedAt: number) => ({
  observedAt,
  stale: false,
  total: 1,
  spools: [
    {
      name: 'PLA',
      material: 'PLA',
      colorHex: 'abcdef',
      remainingGrams: 500,
      location: null,
      archived: false,
    },
  ],
})

test('inventory snapshot events are bounded, credential-free and use authenticated telemetry ingestion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'open3d-inventory-'))
  const queue = new TelemetryQueue(dir, 1000)
  const events = new MemoryTelemetryStore()
  const latest = new Map<string, SpoolInventory>()
  try {
    queue.enqueueInventory(snapshot(2000), 1000)
    queue.enqueueInventory(snapshot(1000), 1001)
    const delivered = await drainTelemetryOnce(
      queue,
      async (body) => {
        const parsed = TelemetryBatch.parse(JSON.parse(body))
        assert.equal(parsed.length, 2)
        assert.ok(parsed.every((event) => event.kind === 'inventory-snapshot'))
        assert.ok(!body.includes('password') && !body.includes('token'))
        for (const event of parsed) {
          if (event.kind !== 'inventory-snapshot') continue
          const old = latest.get(id)
          if (!old || event.inventory.observedAt > old.observedAt)
            latest.set(id, event.inventory)
        }
        const result = await ingestTelemetry(
          body,
          {
            farmId: id,
            agentId: id,
            printerKeys: new Set(),
          },
          events,
        )
        assert.equal(result.ok, true)
        return result.ok ? result.acceptedEventIds : []
      },
      () => 1002,
      new AbortController().signal,
    )
    assert.equal(delivered.status, 'delivered')
    assert.equal(queue.depth, 0)
    assert.equal(latest.get(id)?.observedAt, 2000)
    assert.equal(events.size, 2)
    assert.throws(() =>
      queue.enqueueInventory(
        { ...snapshot(3000), password: 'secret' } as never,
        1003,
      ),
    )
    assert.throws(() =>
      TelemetryBatch.parse([
        {
          eventId: id,
          queuedAt: 1,
          kind: 'inventory-snapshot',
          inventory: { ...snapshot(1), password: 'secret' },
        },
      ]),
    )
  } finally {
    queue.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('inventory summaries cap the number of spools and reject oversized fields', () => {
  assert.equal(
    TelemetryBatch.safeParse([
      {
        eventId: id,
        queuedAt: 1,
        kind: 'inventory-snapshot',
        inventory: {
          ...snapshot(1),
          spools: Array.from({ length: 9 }, () => snapshot(1).spools[0]),
        },
      },
    ]).success,
    false,
  )
  assert.equal(
    TelemetryBatch.safeParse([
      {
        eventId: id,
        queuedAt: 1,
        kind: 'inventory-snapshot',
        inventory: {
          ...snapshot(1),
          spools: [{ ...snapshot(1).spools[0], name: 'x'.repeat(33) }],
        },
      },
    ]).success,
    false,
  )
})
