import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PrinterState } from '@open3dfarmmanager/farm-protocol'
import { serveWsTestServer } from '../unit/ws-serve.ts'
import { createMoonrakerSubscription } from '../../packages/connector/src/moonraker/subscription.ts'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Snapshot events of one subscription whose printer starts in `initial`. */
async function observe(
  initial: 'printing' | 'complete',
  script: (push: (delta: unknown) => void) => Promise<void>,
) {
  const controller = new AbortController()
  const printers: PrinterState[] = []
  const objects: unknown[] = []
  let clock = 0
  let push: (delta: unknown) => void = () => {
    throw Error('Fixture not connected')
  }
  const fixture = await serveWsTestServer({
    http: () =>
      Response.json({
        result: { klippy_connected: true, klippy_state: 'ready' },
      }),
    upgrade: () => true,
    onMessage(socket, raw) {
      const request = JSON.parse(raw)
      if (request.method === 'server.connection.identify') {
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: { connection_id: 1 },
          }),
        )
        return
      }
      objects.push(request.params?.objects)
      push = (delta) =>
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            method: 'notify_status_update',
            params: [delta, ++clock],
          }),
        )
      socket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            eventtime: ++clock,
            status: {
              webhooks: { state: 'ready' },
              print_stats: {
                state: initial,
                filename: 'part.gcode',
                print_duration: 60,
                total_duration: 70,
              },
              virtual_sdcard: { progress: initial === 'printing' ? 0.5 : 1 },
            },
          },
        }),
      )
    },
  })
  const origin = `http://127.0.0.1:${fixture.port}`
  const subscription = createMoonrakerSubscription({
    assignment: { printerKey: 'fixture', origin },
    allowedOrigins: [origin],
    limits: {
      maxMessageBytes: 4096,
      connectTimeoutMs: 1000,
      requestTimeoutMs: 1000,
      staleAfterMs: 5000,
      reconnectMinMs: 100,
      reconnectMaxMs: 1000,
    },
    signal: controller.signal,
    onEvent(event) {
      if (event.kind === 'snapshot') printers.push(event.printer)
    },
  })
  try {
    const deadline = Date.now() + 5000
    while (printers.length === 0) {
      if (Date.now() > deadline) throw Error('No first snapshot')
      await sleep(10)
    }
    await script((delta) => push(delta))
    await sleep(100)
    return { printers, objects }
  } finally {
    controller.abort()
    await subscription.done.catch(() => {})
    await fixture.stop()
  }
}

test('a watched Moonraker job end reaches telemetry with its file', async () => {
  const { printers, objects } = await observe('printing', async (push) => {
    push({
      print_stats: { state: 'complete', print_duration: 90 },
      virtual_sdcard: { progress: 1 },
    })
  })
  // Real Moonraker only reports the fields a subscription names.
  assert.ok(
    (objects[0] as { print_stats: string[] }).print_stats.includes('filename'),
  )
  assert.equal(printers[0]?.lastJob, undefined)
  const last = printers.at(-1)
  assert.equal(last?.state, 'idle')
  assert.deepEqual(
    {
      outcome: last?.lastJob?.outcome,
      filename: last?.lastJob?.filename,
      printDuration: last?.lastJob?.printDuration,
    },
    { outcome: 'completed', filename: 'part.gcode', printDuration: 90 },
  )
})

test('a job already finished on connect is left to the history import', async () => {
  const { printers } = await observe('complete', async () => {})
  assert.ok(printers.length > 0)
  assert.ok(printers.every((printer) => printer.lastJob === undefined))
})
