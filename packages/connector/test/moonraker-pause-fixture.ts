import { createServer } from 'node:http'
import type { WebSocket } from 'ws'
process.env.WS_NO_BUFFER_UTIL = '1'
process.env.WS_NO_UTF_8_VALIDATE = '1'
const { WebSocketServer } = await import('ws')

export async function pauseFixture(
  input: {
    query?: (index: number, socket: WebSocket, id: number) => boolean
    pause?: (socket: WebSocket, id: number) => boolean
  } = {},
) {
  const server = createServer((_request, response) => {
    response.writeHead(404)
    response.end()
  })
  const sockets = new Set<WebSocket>()
  const websocket = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 4096,
  })
  const requests: Array<{
    jsonrpc: string
    id: number
    method: string
    params?: unknown
  }> = []
  let connections = 0,
    queries = 0,
    pauses = 0,
    pongs = 0
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/websocket') {
      socket.destroy()
      return
    }
    websocket.handleUpgrade(request, socket, head, (peer) =>
      websocket.emit('connection', peer),
    )
  })
  websocket.on('connection', (socket) => {
    connections++
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('pong', () => {
      pongs++
    })
    socket.on('close', () => sockets.delete(socket))
    socket.on('message', (data) => {
      const request = JSON.parse(data.toString()) as {
        jsonrpc: string
        id: number
        method: string
        params?: unknown
      }
      requests.push(request)
      if (request.method === 'printer.objects.query') {
        const index = ++queries
        if (input.query?.(index, socket, request.id)) return
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              eventtime: index,
              status: {
                webhooks: { state: 'ready' },
                print_stats: { state: pauses ? 'paused' : 'printing' },
              },
            },
          }),
        )
      } else if (request.method === 'printer.print.pause') {
        pauses++
        if (!input.pause?.(socket, request.id))
          socket.send(
            JSON.stringify({ jsonrpc: '2.0', id: request.id, result: 'ok' }),
          )
      } else socket.terminate()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('No fixture port')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    counts: () => ({
      connections,
      queries,
      pauses,
      sockets: sockets.size,
      pongs,
    }),
    async close() {
      for (const socket of sockets) socket.terminate()
      await new Promise<void>((resolve) => websocket.close(() => resolve()))
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    },
  }
}
