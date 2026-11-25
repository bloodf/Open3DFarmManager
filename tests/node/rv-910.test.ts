import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { TelemetryBatch } from '../../packages/farm-protocol/src/telemetry.ts'
import { drainTelemetryOnce } from '../../packages/connector/src/cloud/drain.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { freshAdvertisedActions } from '../../apps/farm/server/storage/postgres-pause-authority.ts'
import { OBSERVATION_FRESH_MS } from '../../apps/farm/server/utils/integration-telemetry.ts'

const controls = ['pause', 'set_temperature', 'jog', 'run_macro'] as const

test('the restarted Connector sends ages for queued printer state and inventory', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'rv-910-'))
  const queuedAt = 1_000
  let queue = new TelemetryQueue(directory, queuedAt)
  t.after(() => {
    queue.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const state = queue.enqueue(
    {
      printerKey: 'simulator',
      state: 'printing',
      progress: 0.5,
      observedAt: queuedAt - 10,
      controls: [...controls],
    },
    queuedAt,
  )
  const inventory = queue.enqueueInventory(
    { observedAt: queuedAt - 20, stale: false, total: 0, spools: [] },
    queuedAt,
  )
  queue.close()

  // The wall clock may have advanced only slightly during a long outage.
  const reopenedAt = queuedAt + 1
  queue = new TelemetryQueue(directory, reopenedAt)
  const result = await drainTelemetryOnce(
    queue,
    async (body) => {
      const [printerRecord, inventoryRecord] = TelemetryBatch.parse(
        JSON.parse(body),
      )
      assert.ok(printerRecord?.kind === 'printer-state')
      assert.ok(inventoryRecord?.kind === 'inventory-snapshot')
      assert.equal(printerRecord.eventId, state.eventId)
      assert.equal(inventoryRecord.eventId, inventory.eventId)
      const receipt = 2_000_000
      assert.ok(printerRecord.ageAtSendMs! > OBSERVATION_FRESH_MS)
      assert.ok(inventoryRecord.ageAtSendMs! > OBSERVATION_FRESH_MS)
      assert.deepEqual(
        freshAdvertisedActions(
          printerRecord.state.controls,
          printerRecord.ageAtSendMs,
          receipt,
          receipt,
          printerRecord.state.observedAt,
        ),
        [],
      )
      return [printerRecord.eventId, inventoryRecord.eventId]
    },
    () => reopenedAt,
    new AbortController().signal,
  )
  assert.equal(result.status, 'delivered')
  assert.equal(queue.depth, 0)
})
