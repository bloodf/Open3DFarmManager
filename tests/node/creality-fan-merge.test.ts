import test from 'node:test'
import assert from 'node:assert/strict'
import { createCrealityCollection } from '../../packages/connector/src/runtime/creality-collection.ts'
import { createCrealitySimulator } from '../../packages/sim-tools/src/creality-simulator.ts'

test(
  'Creality fan deltas preserve other fans and their freshness',
  { timeout: 5000 },
  async () => {
    const simulator = await createCrealitySimulator({
      state: 1,
      printProgress: 10,
      modelFanPct: 50,
      auxiliaryFanPct: 20,
    })
    const controller = new AbortController()
    let notify: (
      value: Parameters<
        Parameters<typeof createCrealityCollection>[0]['onObservation']
      >[0],
    ) => void
    let next = new Promise<
      Parameters<
        Parameters<typeof createCrealityCollection>[0]['onObservation']
      >[0]
    >((resolve) => {
      notify = resolve
    })
    const collection = createCrealityCollection({
      binding: {
        printerKey: 'creality',
        host: '127.0.0.1',
        port: simulator.port,
      },
      signal: controller.signal,
      onObservation(value) {
        notify(value)
      },
      onUnavailable() {},
    })
    try {
      const first = await next
      next = new Promise((resolve) => {
        notify = resolve
      })
      simulator.emitFrame({ auxiliaryFanPct: 30 })
      const second = await next
      assert.deepEqual(second.printer.fans, { part: 50, aux: 30 })
      assert.deepEqual(
        second.fieldObservedAtMonoMs,
        first.fieldObservedAtMonoMs,
      )
    } finally {
      controller.abort()
      await collection.done
      await simulator.close()
    }
  },
)
