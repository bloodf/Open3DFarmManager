import { appendFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import {
  createMoonrakerSubscription,
  type MoonrakerEvent,
} from '../../packages/connector/src/moonraker/subscription.ts'
import { serveWsTestServer } from './ws-serve.ts'

// Spec-derived fixture. Field definitions and notification envelope:
// https://www.klipper3d.org/Status_Reference.html#print_stats
// https://moonraker.readthedocs.io/en/latest/external_api/printer/#query-printer-object-status
// https://moonraker.readthedocs.io/en/latest/external_api/jsonrpc_notifications/#subscription-updates
const status = {
  webhooks: { state: 'ready', state_message: 'Printer is ready' },
  print_stats: {
    state: 'printing',
    filename: 'part.gcode',
    print_duration: 10.6,
    total_duration: 12.2,
    info: { total_layer: null, current_layer: null },
  },
  display_status: { message: null, progress: 0.4 },
  virtual_sdcard: {
    file_path: '/gcodes/part.gcode',
    file_position: 40,
    progress: 0.4,
  },
  gcode_move: { speed_factor: 1 },
}

test('documented print updates can arrive before the subscription baseline', async () => {
  const abort = new AbortController()
  const events: MoonrakerEvent[] = []
  let queries = 0
  let push: ((status: object, at: number) => void) | undefined
  const server = await serveWsTestServer({
    http: () =>
      Response.json({
        result: { klippy_connected: true, klippy_state: 'ready' },
      }),
    upgrade: () => true,
    onMessage(socket, raw) {
      const call = JSON.parse(raw)
      const reply = (result: object) =>
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }))
      if (call.method === 'server.connection.identify')
        return reply({ connection_id: 1 })
      if (call.method === 'printer.objects.subscribe') {
        push = (status, at) =>
          socket.send(
            JSON.stringify({
              jsonrpc: '2.0',
              method: 'notify_status_update',
              params: [status, at],
            }),
          )
        push({ virtual_sdcard: { file_position: 30, progress: 0.3 } }, 578243.0)
        push(
          {
            virtual_sdcard: { file_position: 50, progress: 0.5 },
            display_status: { message: 'Layer 1' },
          },
          578243.2,
        )
        return reply({ eventtime: 578243.1, status })
      }
      queries++
      reply({
        eventtime: 578243.25,
        status: {
          ...status,
          virtual_sdcard: {
            ...status.virtual_sdcard,
            file_position: 60,
            progress: 0.6,
          },
        },
      })
    },
  })
  const ledger = process.env.MOONRAKER_TEST_LEDGER
  const audit = (state: string) => {
    if (ledger)
      appendFileSync(ledger, JSON.stringify({ id: server.port, state }) + '\n')
  }
  audit('created')
  const origin = `http://127.0.0.1:${server.port}`
  const subscription = createMoonrakerSubscription({
    assignment: { printerKey: 'fixture', origin },
    allowedOrigins: [origin],
    limits: {
      maxMessageBytes: 16384,
      connectTimeoutMs: 1000,
      requestTimeoutMs: 1000,
      staleAfterMs: 5000,
      reconnectMinMs: 100,
      reconnectMaxMs: 1000,
    },
    signal: abort.signal,
    jobFields: true,
    onRawObservation() {},
    onEvent(event) {
      events.push(event)
    },
  })
  try {
    const last = () =>
      events.findLast((event) => event.kind === 'snapshot')?.printer
    await expect.poll(() => last()?.progress).toBe(0.5)
    const progress = events.flatMap((event) =>
      event.kind === 'snapshot' ? [event.printer.progress] : [],
    )
    expect(progress).toEqual([0.4, 0.5])
    await expect.poll(() => last()?.progress, { timeout: 3000 }).toBe(0.6)
    expect(queries).toBeGreaterThanOrEqual(1)
    expect(events).not.toContainEqual({
      kind: 'unavailable',
      printerKey: 'fixture',
      reason: 'invalid-response',
    })
    push?.(
      {
        print_stats: { state: 'complete', info: null },
        display_status: { message: null },
        virtual_sdcard: { file_path: null, file_position: 0, progress: 1 },
      },
      578243.4,
    )
    await expect.poll(() => last()?.state).toBe('idle')
    expect(last()?.lastJob).toMatchObject({
      filename: 'part.gcode',
      outcome: 'completed',
    })
    push?.({ virtual_sdcard: { progress: 'bad' } }, 578243.5)
    await expect
      .poll(() => events.at(-1))
      .toMatchObject({ kind: 'unavailable', reason: 'invalid-response' })
  } finally {
    abort.abort()
    await subscription.done
    await server.stop()
    audit('removed')
  }
})
