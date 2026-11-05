import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createPrinterBindingRegistry } from '../../packages/connector/src/control/printer-binding.ts'
import type { ControlObservation } from '../../packages/connector/src/control/pause-dispatcher.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'
import { pauseFixture } from '../../packages/connector/test/moonraker-pause-fixture.ts'

test('router owns one fixed connection per binding and advances generation only after close', async () => {
  const remote = await pauseFixture({})
  const registry = createPrinterBindingRegistry({
    allowedOrigins: [remote.origin],
  })
  const binding = registry.provision({
    assignment_id: randomUUID(),
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    printer_key: 'router-test',
    moonraker_origin: remote.origin,
  })
  const observed: Array<ControlObservation | null> = []
  const router = createPauseDriverRouter({
    allowedOrigins: [remote.origin],
    limits: {
      maxMessageBytes: 4096,
      connectTimeoutMs: 500,
      requestTimeoutMs: 500,
      staleAfterMs: 2000,
      reconnectMinMs: 100,
      reconnectMaxMs: 100,
    },
    clock: { monotonicNow: () => performance.now() },
    observe: (_binding, observation) => {
      observed.push(observation)
      return true
    },
  })
  try {
    const signal = new AbortController().signal
    assert.deepEqual(await router.prepare({ binding, signal }), {
      connectionGeneration: 1,
    })
    assert.equal(observed.at(-1)?.connectionGeneration, 1)
    await assert.rejects(router.prepare({ binding, signal }))
    assert.equal(remote.counts().connections, 1)
    await router.closeAttempt(binding)
    assert.equal(observed.at(-1), null)
    assert.deepEqual(await router.prepare({ binding, signal }), {
      connectionGeneration: 2,
    })
    assert.equal(observed.at(-1)?.connectionGeneration, 2)
    assert.equal(remote.counts().connections, 2)
    assert.equal(remote.counts().pauses, 0)
  } finally {
    await router.closeAttempt(binding)
    await remote.close()
  }
})

test('a retired connection cannot publish a delayed response over the next generation', async () => {
  let releaseQuery: () => void = () => {}
  let queryArrived: () => void = () => {}
  const arrived = new Promise<void>((resolve) => {
    queryArrived = resolve
  })
  const remote = await pauseFixture({
    query: (index, socket, id) => {
      if (index !== 1) return false
      releaseQuery = () => {
        if (socket.readyState === socket.OPEN)
          socket.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id,
              result: {
                eventtime: 1,
                status: {
                  webhooks: { state: 'ready' },
                  print_stats: { state: 'printing' },
                },
              },
            }),
          )
      }
      queryArrived()
      return true
    },
  })
  const registry = createPrinterBindingRegistry({
    allowedOrigins: [remote.origin],
  })
  const binding = registry.provision({
    assignment_id: randomUUID(),
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    printer_key: 'retired-test',
    moonraker_origin: remote.origin,
  })
  const observed: Array<ControlObservation | null> = []
  const router = createPauseDriverRouter({
    allowedOrigins: [remote.origin],
    limits: {
      maxMessageBytes: 4096,
      connectTimeoutMs: 500,
      requestTimeoutMs: 500,
      staleAfterMs: 2000,
      reconnectMinMs: 100,
      reconnectMaxMs: 100,
    },
    clock: { monotonicNow: () => performance.now() },
    observe: (_binding, observation) => {
      observed.push(observation)
      return true
    },
  })
  try {
    const controller = new AbortController()
    const first = router.prepare({ binding, signal: controller.signal })
    await arrived
    controller.abort()
    await assert.rejects(first)
    await router.closeAttempt(binding)
    await router.prepare({ binding, signal: new AbortController().signal })
    const count = observed.length
    releaseQuery()
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(observed.length, count)
    assert.equal(observed.at(-1)?.connectionGeneration, 2)
    assert.equal(remote.counts().pauses, 0)
  } finally {
    await router.closeAttempt(binding)
    await remote.close()
  }
})
