import { createServer } from 'node:http'
import { once } from 'node:events'
import { WebSocketServer, type WebSocket } from 'ws'

export async function moonrakerSpoolmanFixture() {
  const requests: { path: string; key?: string; authorization?: string }[] = []
  let spoolReply: unknown = { result: { spool_id: 42 } }
  let peer: WebSocket | undefined
  let eventtime = 1
  const token = `x.${Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 3600 })).toString('base64url')}.x`
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    requests.push({
      path,
      key: req.headers['x-api-key'] as string | undefined,
      authorization: req.headers.authorization,
    })
    res.setHeader('content-type', 'application/json')
    if (path === '/server/info')
      res.end(
        JSON.stringify({
          result: { klippy_connected: true, klippy_state: 'ready' },
        }),
      )
    else if (path === '/server/spoolman/spool_id')
      res.end(JSON.stringify(spoolReply))
    else if (path === '/api/v1/spool')
      res.end(
        JSON.stringify([
          {
            id: 42,
            filament: { id: 1, material: 'PLA', color_hex: 'aabbcc' },
            initial_weight: 1000,
            remaining_weight: 500,
            archived: false,
          },
        ]),
      )
    else if (path === '/access/login')
      res.end(JSON.stringify({ result: { token, refresh_token: 'refresh' } }))
    else if (path === '/access/oneshot_token')
      res.end(JSON.stringify({ result: 'oneshot' }))
    else {
      res.statusCode = 404
      res.end('{}')
    }
  })
  const ws = new WebSocketServer({ server })
  ws.on('connection', (socket, req) => {
    if (req.url?.startsWith('/api/v1/')) return
    peer = socket
    socket.on('message', (wire) => {
      const request = JSON.parse(wire.toString())
      socket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            eventtime: eventtime++,
            status: {
              webhooks: { state: 'ready' },
              print_stats: { state: 'printing' },
              virtual_sdcard: { progress: 0.2 },
            },
          },
        }),
      )
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('Missing port')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    token,
    reply(value: unknown) {
      spoolReply = value
    },
    update() {
      if (!peer) throw Error('Moonraker not connected')
      peer.send(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'notify_status_update',
          params: [{ virtual_sdcard: { progress: 0.2 } }, eventtime++],
        }),
      )
    },
    async close() {
      for (const socket of ws.clients) socket.terminate()
      await new Promise<void>((resolve) => ws.close(() => resolve()))
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
