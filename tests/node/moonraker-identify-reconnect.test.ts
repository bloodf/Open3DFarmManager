import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serveWsTestServer, type WsTestSocket } from '../unit/ws-serve.ts'
import { createMoonrakerSubscription } from '../../packages/connector/src/moonraker/subscription.ts'

const limits = {
  maxMessageBytes: 4096,
  connectTimeoutMs: 1000,
  requestTimeoutMs: 1000,
  staleAfterMs: 5000,
  reconnectMinMs: 200,
  reconnectMaxMs: 400,
}
const status = {
  webhooks: { state: 'ready' },
  print_stats: { state: 'printing' },
  virtual_sdcard: { progress: 0.25 },
}

type Call = { connection: number; method: string; at: number; params: unknown }

async function run(options: {
  failIdentifyOnConnection?: number
  subscribes: number
}) {
  const calls: Call[] = []
  const indexes = new Map<WsTestSocket, number>()
  const reasons: string[] = []
  const fixture = await serveWsTestServer({
    http: () =>
      Response.json({
        result: { klippy_connected: true, klippy_state: 'ready' },
      }),
    upgrade: () => true,
    onOpen: (socket) => indexes.set(socket, indexes.size + 1),
    onMessage(socket, wire) {
      const request = JSON.parse(wire)
      const connection = indexes.get(socket)!
      calls.push({
        connection,
        method: request.method,
        at: performance.now(),
        params: request.params,
      })
      if (request.method === 'server.connection.identify') {
        socket.send(
          JSON.stringify(
            connection === options.failIdentifyOnConnection
              ? {
                  jsonrpc: '2.0',
                  id: request.id,
                  error: { code: -32601, message: 'refused' },
                }
              : {
                  jsonrpc: '2.0',
                  id: request.id,
                  result: { connection_id: 7 },
                },
          ),
        )
        return
      }
      const subscribed = calls.filter(
        (call) => call.method === 'printer.objects.subscribe',
      ).length
      socket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: { eventtime: 10 + connection, status },
        }),
      )
      // Drop the live connection so the client must reconnect.
      if (subscribed < options.subscribes)
        setTimeout(() => socket.terminate(), 20)
    },
  })
  const controller = new AbortController()
  let resolveDone!: () => void
  const finished = new Promise<void>((resolve) => (resolveDone = resolve))
  const origin = `http://127.0.0.1:${fixture.port}`
  const subscription = createMoonrakerSubscription({
    assignment: { printerKey: 'fixture-printer', origin },
    allowedOrigins: [origin],
    limits,
    onEvent(event) {
      if (event.kind === 'unavailable') reasons.push(event.reason)
      if (
        event.kind === 'snapshot' &&
        calls.filter((call) => call.method === 'printer.objects.subscribe')
          .length >= options.subscribes
      )
        resolveDone()
    },
    signal: controller.signal,
  })
  const timeout = setTimeout(() => controller.abort(), 8000)
  try {
    await Promise.race([finished, subscription.done])
  } finally {
    clearTimeout(timeout)
    controller.abort()
    await subscription.done
    await fixture.stop()
  }
  return { calls, reasons }
}

test('identify precedes subscribe on every reconnect', async () => {
  const { calls } = await run({ subscribes: 2 })
  assert.deepEqual(
    calls.map((call) => `${call.connection}:${call.method}`),
    [
      '1:server.connection.identify',
      '1:printer.objects.subscribe',
      '2:server.connection.identify',
      '2:printer.objects.subscribe',
    ],
  )
  assert.deepEqual(calls[0]?.params, {
    client_name: 'Open3DFarmManager',
    version: '1',
    type: 'agent',
    url: 'https://open3dfarmmanager.local',
  })
})

test('identify failure backs off and reconnects without subscribing', async () => {
  const { calls, reasons } = await run({
    failIdentifyOnConnection: 1,
    subscribes: 1,
  })
  assert.deepEqual(
    calls.map((call) => `${call.connection}:${call.method}`),
    [
      '1:server.connection.identify',
      '2:server.connection.identify',
      '2:printer.objects.subscribe',
    ],
  )
  assert.ok(reasons.includes('invalid-response'))
  const gap = calls[1]!.at - calls[0]!.at
  assert.ok(gap >= limits.reconnectMinMs - 20, `backoff gap ${gap}ms`)
})
