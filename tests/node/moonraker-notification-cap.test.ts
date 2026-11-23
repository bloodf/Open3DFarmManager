import test, { afterEach, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createPrinterBindingRegistry } from '../../packages/connector/src/control/printer-binding.ts'
import { openFixedMoonrakerPause } from '../../packages/connector/src/moonraker/pause-driver.ts'
import type { ControlObservation } from '../../packages/connector/src/control/pause-dispatcher.ts'
import { pauseFixture } from '../../packages/connector/test/moonraker-pause-fixture.ts'

beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }))
afterEach(() => mock.timers.reset())

const limits = {
  maxMessageBytes: 4096,
  connectTimeoutMs: 500,
  requestTimeoutMs: 1500,
  staleAfterMs: 2000,
  reconnectMinMs: 100,
  reconnectMaxMs: 100,
}

async function openHarness(mode: Parameters<typeof pauseFixture>[0] = {}) {
  const remote = await pauseFixture(mode)
  const registry = createPrinterBindingRegistry({
    allowedOrigins: [remote.origin],
  })
  const binding = registry.provision({
    assignment_id: randomUUID(),
    agent_id: randomUUID(),
    farm_id: randomUUID(),
    printer_key: 'fake-only',
    moonraker_origin: remote.origin,
  })
  const owner = new AbortController()
  const command = new AbortController()
  const observations: Array<ControlObservation | null> = []
  const driver = openFixedMoonrakerPause({
    binding,
    allowedOrigins: [remote.origin],
    limits,
    connectionGeneration: 1,
    clock: { monotonicNow: () => performance.now() },
    publish: (observation) => {
      observations.push(observation)
    },
    signal: owner.signal,
  })
  return {
    remote,
    binding,
    owner,
    command,
    observations,
    driver,
    async cleanup() {
      await driver.close()
      await remote.close()
    },
  }
}

test('control socket stays open across more than 16 unsolicited notifications before a reply (#614)', async () => {
  const procStatPadding = 'x'.repeat(1500)
  const f = await openHarness({
    pause: (socket, id) => {
      for (let i = 0; i < 24; i++) {
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            method:
              i % 2 === 0 ? 'notify_proc_stat_update' : 'notify_gcode_response',
            params:
              i % 2 === 0
                ? [
                    {
                      moonraker_stats: { cpu_usage: i, mem_units: 'kB' },
                      detail: procStatPadding,
                    },
                  ]
                : [`// step ${i}`],
          }),
        )
      }
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, result: 'ok' }))
      return true
    },
    query: (index, socket) => {
      if (index > 1) {
        for (let i = 0; i < 10; i++) {
          socket.send(
            JSON.stringify({
              jsonrpc: '2.0',
              method: 'notify_proc_stat_update',
              params: [{ moonraker_stats: { cpu_usage: i } }],
            }),
          )
        }
      }
      return false
    },
  })

  try {
    await f.driver.prepare()
    let sentMono = 0
    const ack = await f.driver.driver.pauseOnce({
      binding: f.binding,
      signal: f.command.signal,
      beforeSend: () => {
        sentMono = performance.now()
        return true
      },
    })
    assert.deepEqual(ack, { acknowledged: true })

    const paused = await f.driver.driver.waitForPaused({
      binding: f.binding,
      signal: f.command.signal,
      after: { connectionGeneration: 1, sequence: 1, sentMono },
    })
    assert.ok(paused)
    assert.equal(paused.printState, 'paused')
    assert.equal(f.remote.counts().pauses, 1)
    assert.equal(f.remote.counts().connections, 1)
    assert.equal(f.observations.filter(Boolean).length, 2)
  } finally {
    await f.cleanup()
  }
})

test('terminal Klippy lifecycle notifications still close the control socket (#614)', async () => {
  const f = await openHarness({
    pause: (socket) => {
      socket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'notify_klippy_disconnected',
          params: [],
        }),
      )
      return true
    },
  })

  try {
    await f.driver.prepare()
    await assert.rejects(
      f.driver.driver.pauseOnce({
        binding: f.binding,
        signal: f.command.signal,
        beforeSend: () => true,
      }),
    )
    await f.driver.closed
    assert.equal(f.observations.at(-1), null)
    assert.equal(f.remote.counts().pauses, 1)
  } finally {
    await f.cleanup()
  }
})
