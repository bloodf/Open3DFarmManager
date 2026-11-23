import { expect, test } from 'vitest'
import { createMoonrakerSubscription } from '../../packages/connector/src/moonraker/subscription.ts'
import { serveWsTestServer, type WsTestSocket } from './ws-serve.ts'

const initialStatus = {
  webhooks: { state: 'ready' },
  print_stats: { state: 'printing' },
  virtual_sdcard: { progress: 0.5 },
  fan: { speed: 0.4, power: 0.16 },
}

async function scenario(queryFan: { power: number; speed: number }) {
  const sockets = new Set<WsTestSocket>()
  let connectionCount = 0
  let queryAnswered!: () => void
  const queried = new Promise<void>((resolve) => (queryAnswered = resolve))
  const server = await serveWsTestServer({
    http: () =>
      Response.json({
        result: { klippy_connected: true, klippy_state: 'ready' },
      }),
    upgrade: () => true,
    onOpen(socket) {
      sockets.add(socket)
      connectionCount++
    },
    onClose(socket) {
      sockets.delete(socket)
    },
    onMessage(socket, message) {
      const call = JSON.parse(message)
      const reply = (result: unknown) =>
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }))
      if (call.method === 'server.connection.identify')
        return reply({ connection_id: 1 })
      if (call.method === 'printer.objects.subscribe') {
        reply({ eventtime: 10, status: initialStatus })
        setTimeout(
          () =>
            socket.send(
              JSON.stringify({
                jsonrpc: '2.0',
                method: 'notify_status_update',
                params: [{ fan: { power: 0.16, speed: 0.4 } }, 11],
              }),
            ),
          10,
        )
        return
      }
      if (call.method === 'printer.objects.query') {
        reply({
          eventtime: 11,
          status: {
            ...initialStatus,
            fan: queryFan,
          },
        })
        queryAnswered()
      }
    },
  })
  const controller = new AbortController()
  const events: { kind: string; reason?: string }[] = []
  const subscription = createMoonrakerSubscription({
    assignment: {
      printerKey: 'fixture',
      origin: `http://127.0.0.1:${server.port}`,
    },
    allowedOrigins: [`http://127.0.0.1:${server.port}`],
    limits: {
      maxMessageBytes: 4096,
      connectTimeoutMs: 1000,
      requestTimeoutMs: 2000,
      staleAfterMs: 5000,
      reconnectMinMs: 3000,
      reconnectMaxMs: 3000,
    },
    onRawObservation() {},
    onEvent(event) {
      events.push(event)
      if (event.kind === 'unavailable' && event.reason === 'invalid-response')
        controller.abort()
    },
    signal: controller.signal,
  })
  return {
    events,
    queryAnswered: queried,
    connectionCount: () => connectionCount,
    async close() {
      controller.abort()
      await subscription.done
      for (const socket of sockets) socket.terminate()
      await server.stop()
    },
  }
}

test('same eventtime accepts equivalent status when nested object keys are reordered', async () => {
  const service = await scenario({ power: 0.16, speed: 0.4 })
  try {
    await service.queryAnswered
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(service.connectionCount()).toBe(1)
    expect(service.events).not.toContainEqual(
      expect.objectContaining({
        kind: 'unavailable',
        reason: 'invalid-response',
      }),
    )
  } finally {
    await service.close()
  }
})

test('same eventtime rejects a status with a changed value as ambiguous', async () => {
  const service = await scenario({ power: 0.2, speed: 0.4 })
  try {
    await service.queryAnswered
    await expect
      .poll(() => service.events)
      .toContainEqual(
        expect.objectContaining({
          kind: 'unavailable',
          reason: 'invalid-response',
        }),
      )
  } finally {
    await service.close()
  }
})
