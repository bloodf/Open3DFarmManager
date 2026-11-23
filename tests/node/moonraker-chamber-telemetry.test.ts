// spec-derived, not captured: https://moonraker.readthedocs.io/en/latest/external_api/printer/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serveWsTestServer, type WsTestSocket } from '../unit/ws-serve.ts'
import type { RawPrinterObservation } from '../../packages/connector/src/runtime/farm-snapshot-provider.ts'
import type { LocalCollectorConfig } from '../../packages/connector/src/config/local.ts'
import { collectIntoQueue } from '../../packages/connector/src/runtime/collect.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'

/** Tiny chamber movements an idle printer produces while the sensor jitters. */
const CHAMBER_UPDATES = 40
const CHAMBER_START = 20
const CHAMBER_STEP = 0.01
/** At most this many durable records may follow a burst of jitter. */
const MAX_QUEUED_RECORDS = 2

function status(chamber: number, eventtime: number) {
  return {
    eventtime,
    status: {
      webhooks: { state: 'ready' },
      print_stats: {
        state: 'standby',
        filename: '',
        print_duration: 0,
        total_duration: 0,
        filament_used: 0,
        info: {},
      },
      virtual_sdcard: { progress: 0 },
      extruder: { temperature: 20, target: 0 },
      'heater_generic chamber': { temperature: chamber, target: 0 },
    },
  }
}

/**
 * A Moonraker that reports one chamber sensor and then jitters it. The
 * jitter never touches another field, so every update is a chamber-only
 * change on an idle printer.
 */
async function fixture() {
  const sockets = new Set<WsTestSocket>()
  let chamber = CHAMBER_START
  let eventtime = 1
  let updates = 0
  function send(socket: WsTestSocket, value: number) {
    chamber = value
    socket.send(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'notify_status_update',
        params: [
          { 'heater_generic chamber': { temperature: chamber } },
          eventtime++,
        ],
      }),
    )
  }
  const server = await serveWsTestServer({
    http(request) {
      if (new URL(request.url).pathname === '/server/info')
        return Response.json({
          result: { klippy_connected: true, klippy_state: 'ready' },
        })
      return new Response('{}', { status: 404 })
    },
    upgrade: () => true,
    onOpen(socket) {
      sockets.add(socket)
    },
    onClose(socket) {
      sockets.delete(socket)
    },
    onMessage(socket, wire) {
      const request = JSON.parse(wire) as { id: number; method: string }
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
      if (request.method === 'printer.objects.list') {
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              objects: [
                'webhooks',
                'print_stats',
                'virtual_sdcard',
                'extruder',
                'heater_generic chamber',
              ],
            },
          }),
        )
        return
      }
      socket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: status(chamber, eventtime++),
        }),
      )
      if (request.method !== 'printer.objects.subscribe') return
      // The printer now jitters its chamber sensor and nothing else.
      for (let index = 1; index <= CHAMBER_UPDATES; index++) {
        updates++
        send(socket, CHAMBER_START + index * CHAMBER_STEP)
      }
    },
  })
  return {
    origin: `http://127.0.0.1:${server.port}`,
    updates: () => updates,
    /** A deliberate chamber move, well past the jitter of the sensor. */
    async move(value: number) {
      for (const socket of sockets) send(socket, value)
      await new Promise((resolve) => setTimeout(resolve, 50))
    },
    close: () => server.stop(),
  }
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 10_000
  while (!predicate()) {
    if (Date.now() > deadline) throw Error('Timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function config(origin: string): LocalCollectorConfig {
  return {
    version: 1,
    allowedOrigins: [origin],
    printers: [{ printerKey: 'chamber-sim', origin }],
    limits: {
      maxMessageBytes: 4096,
      connectTimeoutMs: 2000,
      requestTimeoutMs: 2000,
      staleAfterMs: 30_000,
      reconnectMinMs: 100,
      reconnectMaxMs: 200,
    },
  }
}

test('many tiny chamber changes keep durable records bounded and the live value current', async () => {
  const server = await fixture()
  const directory = mkdtempSync(join(tmpdir(), 'open3d-chamber-'))
  const queue = new TelemetryQueue(join(directory, 'queue'), Date.now())
  const live: RawPrinterObservation[] = []
  const controller = new AbortController()
  const done = collectIntoQueue({
    config: config(server.origin),
    queue,
    signal: controller.signal,
    onDiagnostic() {},
    onRawObservation(observation) {
      live.push(observation)
    },
  })
  try {
    await waitFor(() => server.updates() === CHAMBER_UPDATES)
    await waitFor(() => live.length > CHAMBER_UPDATES)
    // The live reading follows the sensor without waiting for a durable record.
    assert.equal(
      live.at(-1)!.printer.chamberTemperatureCelsius,
      CHAMBER_START + CHAMBER_UPDATES * CHAMBER_STEP,
    )
    // The jitter must not enqueue one durable record per update.
    assert.ok(
      queue.depth <= MAX_QUEUED_RECORDS,
      `expected at most ${MAX_QUEUED_RECORDS} queued records, got ${queue.depth}`,
    )
    assert.ok(queue.depth < CHAMBER_UPDATES)
  } finally {
    controller.abort()
    await done
    await server.close()
    queue.close()
    rmSync(directory, { recursive: true })
  }
})

test('a meaningful chamber change is still recorded as a durable observation', async () => {
  const server = await fixture()
  const directory = mkdtempSync(join(tmpdir(), 'open3d-chamber-'))
  const queue = new TelemetryQueue(join(directory, 'queue'), Date.now())
  const controller = new AbortController()
  const done = collectIntoQueue({
    config: config(server.origin),
    queue,
    signal: controller.signal,
    onDiagnostic() {},
  })
  try {
    await waitFor(() => server.updates() === CHAMBER_UPDATES)
    await waitFor(() => queue.depth > 0)
    const before = queue.depth
    await server.move(CHAMBER_START + 5)
    await waitFor(() => queue.depth > before)
    const states = queue
      .batch(Date.now())
      .records.filter((record) => record.kind === 'printer-state')
    assert.equal(states.length, queue.depth)
    const last = states.at(-1)
    assert.equal(last?.kind, 'printer-state')
    assert.equal(
      last?.state.chamberTemperatureCelsius,
      CHAMBER_START + 5,
      'a durable record carries the chamber reading it was written with',
    )
  } finally {
    controller.abort()
    await done
    await server.close()
    queue.close()
    rmSync(directory, { recursive: true })
  }
})
