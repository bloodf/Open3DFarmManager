import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import { test } from 'node:test'
import {
  inspectTelemetryRequest,
  readTelemetryBytes,
  telemetryNodeRequest,
} from '../../apps/farm/server/services/telemetry-http-boundary.ts'

test('Node boundary preserves exact target and rejects ambiguous headers and streams', async () => {
  const outcomes: string[] = []
  let markSeen: (() => void) | undefined
  let markDone: (() => void) | undefined
  const server = createServer(async (req, res) => {
    markSeen?.()
    res.setHeader('connection', 'close')
    try {
      assert.equal(telemetryNodeRequest({ '~app': { node: { req } } }), req)
      inspectTelemetryRequest(req)
      const body = await readTelemetryBytes(req, 80)
      outcomes.push(Buffer.from(body).toString())
      res.end('ok')
    } catch {
      outcomes.push('rejected')
      if (!res.destroyed) res.end('rejected')
    } finally {
      markDone?.()
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No port')
  const port = address.port
  async function send(request: string, disconnect = false) {
    const socket = net.createConnection({
      host: '127.0.0.1',
      port,
    })
    socket.setTimeout(2000, () => socket.destroy())
    socket.on('error', () => {})
    socket.on('data', () => {})
    await once(socket, 'connect')
    const done = new Promise<void>((resolve) => {
      markDone = resolve
    })
    const seen = new Promise<void>((resolve) => {
      markSeen = resolve
    })
    socket.write(request)
    if (disconnect) {
      await seen
      socket.destroy()
    }
    await once(socket, 'close')
    await done
    markSeen = undefined
    markDone = undefined
  }
  const head =
    'POST /api/connector/telemetry HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n'
  try {
    await send(head + 'Content-Length: 2\r\nConnection: close\r\n\r\n{}')
    await send(
      head +
        'X-Telemetry-Signature: a\r\nx-telemetry-signature: b\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}',
    )
    await send(
      'POST /api/connector/x/../telemetry HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}',
    )
    await send(head + 'Content-Length: 65537\r\nConnection: close\r\n\r\n{}')
    await send(head + 'Content-Length: 2\r\nConnection: close\r\n\r\n{')
    await send(head + 'Content-Length: 2\r\nConnection: close\r\n\r\n{', true)
    assert.deepEqual(outcomes, [
      '{}',
      'rejected',
      'rejected',
      'rejected',
      'rejected',
      'rejected',
    ])
    assert.throws(() =>
      telemetryNodeRequest({ req: new Request('http://localhost') }),
    )
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})
