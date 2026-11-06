import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createHash } from 'node:crypto'
import type { Duplex } from 'node:stream'
import type { AddressInfo } from 'node:net'

export interface WsTestSocket {
  send: (text: string) => void
  close: () => void
  terminate: () => void
}

export interface WsTestServer {
  port: number
  stop: () => Promise<void>
}

// Minimal RFC6455 test fixture: plain HTTP via `http`, and WebSocket
// upgrade/text frames for the former Bun.serve websocket tests. Only what
// the Moonraker fixtures need: text messages, close, ping/pong and terminate.
export function serveWsTestServer(handlers: {
  http: (request: Request) => Response | Promise<Response>
  upgrade?: (request: Request) => boolean | 'hang'
  onOpen?: (socket: WsTestSocket) => void
  onMessage?: (socket: WsTestSocket, message: string) => void
  onClose?: (socket: WsTestSocket) => void
  tls?: { cert: Buffer; key: Buffer }
}): WsTestServer {
  const sockets = new Set<Duplex>()
  const server: Server = handlers.tls
    ? createHttpsServer(handlers.tls, (req, res) => {
        void respond(req, res)
      })
    : createServer((req, res) => {
        void respond(req, res)
      })
  function respond(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      void (async () => {
        try {
          const headers = new Headers()
          for (const [name, value] of Object.entries(req.headers)) {
            if (Array.isArray(value))
              for (const item of value) headers.append(name, item)
            else if (value !== undefined) headers.set(name, value)
          }
          const hasBody = !['GET', 'HEAD'].includes(req.method ?? '')
          const request = new Request(
            `http://${req.headers.host ?? '127.0.0.1'}${req.url ?? '/'}`,
            {
              method: req.method,
              headers,
              ...(hasBody ? { body: Buffer.concat(chunks) } : {}),
            },
          )
          const response = await handlers.http(request)
          res.writeHead(
            response.status,
            Object.fromEntries(response.headers.entries()),
          )
          res.end(Buffer.from(await response.arrayBuffer()))
        } catch (error) {
          res.writeHead(500)
          res.end()
          console.error(error)
        }
      })()
    })
  }
  server.on('upgrade', (request, socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
    const upgradeRequest = new Request(
      `http://${request.headers.host ?? '127.0.0.1'}${request.url ?? '/'}`,
      {
        method: request.method,
        headers: request.headers as Record<string, string>,
      },
    )
    const accept = handlers.upgrade?.(upgradeRequest) ?? false
    if (accept === 'hang') return
    if (!accept) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      socket.destroy()
      return
    }
    const key = request.headers['sec-websocket-key']
    if (typeof key !== 'string') {
      socket.destroy()
      return
    }
    const acceptKey = createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
        acceptKey +
        '\r\n\r\n',
    )
    function frame(opcode: number, payload: Buffer): Buffer {
      let header: Buffer
      if (payload.length < 126) {
        header = Buffer.alloc(2)
        header[1] = payload.length
      } else if (payload.length < 65536) {
        header = Buffer.alloc(4)
        header[1] = 126
        header.writeUInt16BE(payload.length, 2)
      } else {
        header = Buffer.alloc(10)
        header[1] = 127
        header.writeBigUInt64BE(BigInt(payload.length), 2)
      }
      header[0] = 0x80 | opcode
      return Buffer.concat([header, payload])
    }
    const ws: WsTestSocket = {
      send: (text) => socket.write(frame(0x1, Buffer.from(text))),
      close: () => {
        socket.write(frame(0x8, Buffer.alloc(0)))
        socket.end()
      },
      terminate: () => socket.destroy(),
    }
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
      for (;;) {
        if (buffer.length < 2) return
        const fin = (buffer[0]! & 0x80) !== 0
        const opcode = buffer[0]! & 0x0f
        const masked = (buffer[1]! & 0x80) !== 0
        let length = buffer[1]! & 0x7f
        let offset = 2
        if (length === 126) {
          if (buffer.length < 4) return
          length = buffer.readUInt16BE(2)
          offset = 4
        } else if (length === 127) {
          if (buffer.length < 10) return
          length = Number(buffer.readBigUInt64BE(2))
          offset = 10
        }
        const maskOffset = offset
        if (masked) offset += 4
        if (buffer.length < offset + length) return
        let payload = buffer.subarray(offset, offset + length)
        if (masked) {
          payload = Buffer.from(payload)
          for (let i = 0; i < payload.length; i++)
            payload[i] = payload[i]! ^ buffer[maskOffset + (i % 4)]!
        }
        buffer = buffer.subarray(offset + length)
        if (opcode === 0x8) {
          handlers.onClose?.(ws)
          socket.end()
          return
        }
        if (opcode === 0x9) {
          socket.write(frame(0xa, payload))
          continue
        }
        if (opcode === 0x1 && fin)
          handlers.onMessage?.(ws, payload.toString('utf8'))
      }
    })
    handlers.onOpen?.(ws)
  })
  server.listen(0, '127.0.0.1')
  const { port } = server.address() as AddressInfo
  return {
    port,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
