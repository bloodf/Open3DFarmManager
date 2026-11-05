import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createPrinterBindingRegistry } from '../../packages/connector/src/control/printer-binding.ts'
import { openFixedMoonrakerPause } from '../../packages/connector/src/moonraker/pause-driver.ts'
import type { ControlObservation } from '../../packages/connector/src/control/pause-dispatcher.ts'
import { pauseFixture } from '../../packages/connector/test/moonraker-pause-fixture.ts'

const limits = {
  maxMessageBytes: 4096,
  connectTimeoutMs: 500,
  requestTimeoutMs: 500,
  staleAfterMs: 2000,
  reconnectMinMs: 100,
  reconnectMaxMs: 100,
}
async function fixture(
  mode: Parameters<typeof pauseFixture>[0] = {},
  clock: () => number = () => performance.now(),
) {
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
  const owner = new AbortController(),
    command = new AbortController()
  const observations: Array<ControlObservation | null> = []
  const driver = openFixedMoonrakerPause({
    binding,
    allowedOrigins: [remote.origin],
    limits,
    connectionGeneration: 7,
    clock: { monotonicNow: clock },
    publish: (observation) => {
      observations.push(observation)
    },
    signal: owner.signal,
  })
  return {
    remote,
    registry,
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

test('fixed one-shot WS pause and complete-query evidence preserve exact scope and audit lifetime', async () => {
  const f = await fixture()
  try {
    const start = performance.now()
    await f.driver.prepare()
    const initial = f.observations.at(-1)
    assert.ok(initial)
    assert.equal(initial.ready, true)
    assert.equal(initial.printState, 'printing')
    assert.equal(initial.connectionGeneration, 7)
    assert.ok(
      initial.readyObservedMono >= start &&
        initial.readyObservedMono <= initial.receivedMono,
    )
    let guards = 0,
      sentMono = 0
    const ack = await f.driver.driver.pauseOnce({
      binding: f.binding,
      signal: f.command.signal,
      beforeSend: () => {
        guards++
        sentMono = performance.now()
        return true
      },
    })
    assert.deepEqual(ack, { acknowledged: true })
    const paused = await f.driver.driver.waitForPaused({
      binding: f.binding,
      signal: f.command.signal,
      after: { connectionGeneration: 7, sequence: 1, sentMono },
    })
    assert.ok(paused)
    assert.equal(paused.printState, 'paused')
    assert.ok(paused.printStateObservedMono > sentMono)
    assert.equal(guards, 1)
    assert.deepEqual(
      f.remote.requests.map((r) => r.method),
      ['printer.objects.query', 'printer.print.pause', 'printer.objects.query'],
    )
    assert.deepEqual(f.remote.requests[0]?.params, {
      objects: { webhooks: ['state'], print_stats: ['state'] },
    })
    assert.deepEqual(f.remote.requests[1], {
      jsonrpc: '2.0',
      id: 2,
      method: 'printer.print.pause',
    })
    f.command.abort() // Dispatcher cleanup; permanent context remains alive for final pure audit.
    assert.equal(f.observations.at(-1), paused)
    f.owner.abort()
    await f.driver.closed
    assert.equal(f.observations.at(-1), null)
    await assert.rejects(
      f.driver.driver.pauseOnce({
        binding: f.binding,
        signal: new AbortController().signal,
        beforeSend: () => true,
      }),
    )
    assert.equal(f.remote.counts().pauses, 1)
  } finally {
    await f.cleanup()
  }
})

test('false or throwing final guard permits zero pause writes and closes actual socket', async () => {
  for (const throwing of [false, true]) {
    const f = await fixture()
    try {
      await f.driver.prepare()
      await assert.rejects(
        f.driver.driver.pauseOnce({
          binding: f.binding,
          signal: f.command.signal,
          beforeSend: () => {
            if (throwing) throw Error('synthetic guard')
            return false
          },
        }),
      )
      await f.driver.closed
      assert.equal(f.remote.counts().pauses, 0)
      assert.equal(f.observations.at(-1), null)
    } finally {
      await f.cleanup()
    }
  }
})

test('incomplete, binary, duplicate-key, oversized, wrong-id and unsolicited progress replies never establish freshness', async () => {
  for (const fault of [
    'missing',
    'binary',
    'duplicate',
    'oversize',
    'wrong-id',
    'progress',
  ] as const) {
    const f = await fixture({
      query: (_index, socket, id) => {
        if (fault === 'missing')
          socket.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id,
              result: {
                eventtime: 1,
                status: { webhooks: { state: 'ready' } },
              },
            }),
          )
        if (fault === 'binary') socket.send(Buffer.from('{}'))
        if (fault === 'duplicate')
          socket.send(`{"jsonrpc":"2.0","id":${id},"id":${id},"result":{}}`)
        if (fault === 'oversize') socket.send('x'.repeat(4097))
        if (fault === 'wrong-id')
          socket.send(JSON.stringify({ jsonrpc: '2.0', id: 99, result: {} }))
        if (fault === 'progress')
          socket.send(
            JSON.stringify({
              jsonrpc: '2.0',
              method: 'notify_status_update',
              params: [{ virtual_sdcard: { progress: 0.5 } }, 2],
            }),
          )
        return true
      },
    })
    try {
      await assert.rejects(f.driver.prepare())
      await f.driver.closed
      assert.deepEqual(f.observations, [null], fault)
      assert.equal(f.remote.counts().connections, 1)
    } finally {
      await f.cleanup()
    }
  }
})

test('lost, malformed and disconnected pause acknowledgements never retry or claim success', async () => {
  for (const fault of ['lost', 'wrong', 'closed'] as const) {
    const f = await fixture({
      pause: (socket, id) => {
        if (fault === 'wrong')
          socket.send(JSON.stringify({ jsonrpc: '2.0', id, result: true }))
        if (fault === 'closed') socket.terminate()
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
      assert.equal(f.remote.counts().pauses, 1, fault)
      assert.equal(f.remote.counts().connections, 1, fault)
      assert.equal(f.observations.at(-1), null)
    } finally {
      await f.cleanup()
    }
  }
})

test('post-send repeated source time rejects instead of refreshing paused evidence', async () => {
  const f = await fixture({
    query: (index, socket, id) => {
      if (index === 1) return false
      socket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            eventtime: 1,
            status: {
              webhooks: { state: 'ready' },
              print_stats: { state: 'paused' },
            },
          },
        }),
      )
      return true
    },
  })
  try {
    await f.driver.prepare()
    const sentMono = performance.now()
    await f.driver.driver.pauseOnce({
      binding: f.binding,
      signal: f.command.signal,
      beforeSend: () => true,
    })
    await assert.rejects(
      f.driver.driver.waitForPaused({
        binding: f.binding,
        signal: f.command.signal,
        after: { connectionGeneration: 7, sequence: 1, sentMono },
      }),
    )
    assert.equal(f.observations.filter(Boolean).length, 1)
    assert.equal(f.observations.at(-1), null)
  } finally {
    await f.cleanup()
  }
})

test('pre-result cancellation and mapping retirement close without reconnect or new writes', async () => {
  for (const fault of ['abort', 'retire'] as const) {
    const f = await fixture()
    try {
      await f.driver.prepare()
      if (fault === 'abort') f.command.abort()
      else f.registry.retire(f.binding)
      await assert.rejects(
        f.driver.driver.pauseOnce({
          binding: f.binding,
          signal: f.command.signal,
          beforeSend: () => true,
        }),
      )
      await f.driver.closed
      assert.equal(f.remote.counts().pauses, 0)
      assert.equal(f.observations.at(-1), null)
    } finally {
      await f.cleanup()
    }
  }
})

test('native ping and excessive fragmented valid JSON terminate without freshness or pong', async () => {
  for (const fault of ['ping', 'fragments'] as const) {
    const f = await fixture({
      query: (_index, socket, id) => {
        if (fault === 'ping') socket.ping('bounded')
        else {
          const wire = JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: {
              eventtime: 1,
              status: {
                webhooks: { state: 'ready' },
                print_stats: { state: 'printing' },
              },
            },
          })
          for (let i = 0; i < 33; i++)
            socket.send(
              wire.slice(
                Math.floor((i * wire.length) / 33),
                Math.floor(((i + 1) * wire.length) / 33),
              ),
              { fin: i === 32, binary: false },
            )
        }
        return true
      },
    })
    try {
      await assert.rejects(f.driver.prepare())
      await f.driver.closed
      assert.deepEqual(f.observations, [null])
      assert.equal(f.remote.counts().pongs, 0)
    } finally {
      await f.cleanup()
    }
  }
})

test('unsolicited pong terminates before an otherwise valid query reply', async () => {
  const f = await fixture({
    query: (_index, socket) => {
      socket.pong('unsolicited')
      return false
    },
  })
  try {
    await assert.rejects(f.driver.prepare())
    await f.driver.closed
    assert.deepEqual(f.observations, [null])
  } finally {
    await f.cleanup()
  }
})

test('post-send queries are bounded and never retry a pause that remains unconfirmed', async () => {
  const f = await fixture({
    query: (index, socket, id) => {
      if (index === 1) return false
      socket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            eventtime: index,
            status: {
              webhooks: { state: 'ready' },
              print_stats: { state: 'printing' },
            },
          },
        }),
      )
      return true
    },
  })
  try {
    await f.driver.prepare()
    let sentMono = 0
    await f.driver.driver.pauseOnce({
      binding: f.binding,
      signal: f.command.signal,
      beforeSend: () => {
        sentMono = performance.now()
        return true
      },
    })
    await assert.rejects(
      f.driver.driver.waitForPaused({
        binding: f.binding,
        signal: f.command.signal,
        after: { connectionGeneration: 7, sequence: 1, sentMono },
      }),
    )
    assert.equal(f.remote.counts().queries, 9)
    assert.equal(f.remote.counts().pauses, 1)
    assert.equal(f.remote.counts().connections, 1)
    assert.equal(f.observations.at(-1), null)
  } finally {
    await f.cleanup()
  }
})

test('cancellation while awaiting post-send evidence joins actual socket close', async () => {
  let resolveQuery: () => void = () => {}
  const queryStarted = new Promise<void>((resolve) => {
    resolveQuery = resolve
  })
  const f = await fixture({
    query: (index) => {
      if (index === 1) return false
      resolveQuery()
      return true
    },
  })
  try {
    await f.driver.prepare()
    let sentMono = 0
    await f.driver.driver.pauseOnce({
      binding: f.binding,
      signal: f.command.signal,
      beforeSend: () => {
        sentMono = performance.now()
        return true
      },
    })
    const failed = assert.rejects(
      f.driver.driver.waitForPaused({
        binding: f.binding,
        signal: f.command.signal,
        after: { connectionGeneration: 7, sequence: 1, sentMono },
      }),
    )
    await queryStarted
    f.command.abort()
    await failed
    await f.driver.closed
    assert.equal(f.observations.at(-1), null)
    assert.equal(f.remote.counts().pauses, 1)
  } finally {
    await f.cleanup()
  }
})

test('clock regression and original lifetime expiry deny before a send', async () => {
  for (const value of [999, 31000]) {
    let mono = 1000
    const f = await fixture({}, () => mono)
    try {
      await f.driver.prepare()
      mono = value
      let guards = 0
      await assert.rejects(
        f.driver.driver.pauseOnce({
          binding: f.binding,
          signal: f.command.signal,
          beforeSend: () => {
            guards++
            return true
          },
        }),
      )
      await f.driver.closed
      assert.equal(guards, 0)
      assert.equal(f.remote.counts().pauses, 0)
      assert.equal(f.observations.at(-1), null)
    } finally {
      await f.cleanup()
    }
  }
})

test('another genuine binding cannot select a different endpoint or reuse the prepared socket', async () => {
  const f = await fixture()
  try {
    await f.driver.prepare()
    const foreign = createPrinterBindingRegistry({
      allowedOrigins: [f.remote.origin],
    }).provision({
      assignment_id: randomUUID(),
      agent_id: randomUUID(),
      farm_id: randomUUID(),
      printer_key: 'other-fake',
      moonraker_origin: f.remote.origin,
    })
    await assert.rejects(
      f.driver.driver.pauseOnce({
        binding: foreign,
        signal: f.command.signal,
        beforeSend: () => true,
      }),
    )
    await f.driver.closed
    assert.equal(f.remote.counts().pauses, 0)
    assert.equal(f.observations.at(-1), null)
  } finally {
    await f.cleanup()
  }
})
