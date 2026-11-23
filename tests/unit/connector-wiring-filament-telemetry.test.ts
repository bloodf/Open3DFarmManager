import { expect, test } from 'vitest'
import { createMoonrakerSubscription } from '../../packages/connector/src/moonraker/subscription.ts'
import { serveWsTestServer } from './ws-serve.ts'

test('a watched Moonraker completion retains measured filament usage', async () => {
  let requested = false
  const server = await serveWsTestServer({
    async http() {
      return Response.json({
        result: { klippy_connected: true, klippy_state: 'ready' },
      })
    },
    upgrade() {
      return true
    },
    onOpen() {},
    onClose() {},
    onMessage(socket, message) {
      const call = JSON.parse(message)
      if (call.method === 'server.connection.identify') {
        socket.send(
          JSON.stringify({
            id: call.id,
            jsonrpc: '2.0',
            result: { connection_id: 1 },
          }),
        )
        return
      }
      if (call.method === 'printer.objects.subscribe') {
        requested = call.params.objects.print_stats.includes('filament_used')
        socket.send(
          JSON.stringify({
            id: call.id,
            jsonrpc: '2.0',
            result: {
              eventtime: 1,
              status: {
                webhooks: { state: 'ready' },
                print_stats: { state: 'printing', filament_used: 10 },
                virtual_sdcard: { progress: 0.5 },
              },
            },
          }),
        )
        setTimeout(
          () =>
            socket.send(
              JSON.stringify({
                jsonrpc: '2.0',
                method: 'notify_status_update',
                params: [
                  { print_stats: { state: 'complete', filament_used: 123 } },
                  2,
                ],
              }),
            ),
          20,
        )
      }
    },
  })
  const origin = `http://127.0.0.1:${server.port}`
  const controller = new AbortController()
  let resolve!: (value: number | undefined) => void
  const finished = new Promise<number | undefined>((done) => {
    resolve = done
  })
  const subscription = createMoonrakerSubscription({
    assignment: { printerKey: 'simulator', origin },
    allowedOrigins: [origin],
    limits: {
      maxMessageBytes: 262144,
      connectTimeoutMs: 1000,
      requestTimeoutMs: 1000,
      staleAfterMs: 5000,
      reconnectMinMs: 100,
      reconnectMaxMs: 100,
    },
    jobFields: true,
    signal: controller.signal,
    onEvent(event) {
      if (event.kind === 'snapshot' && event.printer.lastJob)
        resolve(event.printer.lastJob.filamentUsedMillimetres)
    },
  })
  try {
    expect(
      await Promise.race([
        finished,
        new Promise((_, reject) =>
          setTimeout(() => reject(Error('simulator timed out')), 3000),
        ),
      ]),
    ).toBe(123)
    expect(requested).toBe(true)
  } finally {
    controller.abort()
    await subscription.done
    await server.stop()
  }
})
