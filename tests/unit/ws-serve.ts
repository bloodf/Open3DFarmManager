import {
  createServer,
  type Server,
  type IncomingMessage,
  ServerResponse,
} from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createHash } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { once } from 'node:events'

export interface WsTestSocket {
  send: (text: string | Buffer) => void
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
export async function serveWsTestServer(handlers: {
  http: (request: Request) => Response | Promise<Response>
  upgrade?: (request: Request) => boolean | 'hang'
  onOpen?: (socket: WsTestSocket) => void
  onMessage?: (socket: WsTestSocket, message: string) => void
  onClose?: (socket: WsTestSocket) => void
  tls?: { cert: Buffer; key: Buffer }
}): Promise<WsTestServer> {
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
            `${handlers.tls ? 'https' : 'http'}://${req.headers.host ?? '127.0.0.1'}${req.url ?? '/'}`,
            {
              method: req.method ?? 'GET',
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
  server.on('upgrade', (request, socket, head) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('end', () => socket.end())
    socket.once('close', () => sockets.delete(socket))
    const upgradeRequest = new Request(
      `${handlers.tls ? 'https' : 'http'}://${request.headers.host ?? '127.0.0.1'}${request.url ?? '/'}`,
      {
        method: request.method ?? 'GET',
        headers: Object.entries(request.headers).flatMap(([name, value]) =>
          value === undefined
            ? []
            : (Array.isArray(value) ? value : [value]).map(
                (item) => [name, item] satisfies [string, string],
              ),
        ),
      },
    )
    if (!handlers.upgrade) {
      const response = new ServerResponse(request)
      response.assignSocket(socket)
      void Promise.resolve(handlers.http(upgradeRequest))
        .then(async (result) => {
          response.writeHead(result.status, {
            ...Object.fromEntries(result.headers.entries()),
            connection: 'close',
          })
          response.end(Buffer.from(await result.arrayBuffer()))
        })
        .catch(() => socket.destroy())
      return
    }
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
      send: (text) =>
        socket.write(
          frame(typeof text === 'string' ? 0x1 : 0x2, Buffer.from(text)),
        ),
      close: () => {
        socket.write(frame(0x8, Buffer.alloc(0)))
        socket.end()
      },
      terminate: () => socket.destroy(),
    }
    socket.once('close', () => handlers.onClose?.(ws))
    let buffer: Buffer = Buffer.alloc(0)
    let fragments: Buffer[] = []
    let fragmentBytes = 0
    let fragmentOpcode = 0
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
        if (!Number.isSafeInteger(length) || length > 1024 * 1024) {
          socket.destroy()
          return
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
          socket.write(frame(0x8, payload))
          socket.end()
          return
        }
        if (opcode === 0x9) {
          socket.write(frame(0xa, payload))
          continue
        }
        if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
          if (opcode !== 0) {
            if (fragmentOpcode !== 0) {
              socket.destroy()
              return
            }
            fragmentOpcode = opcode
          } else if (fragmentOpcode === 0) {
            socket.destroy()
            return
          }
          fragments.push(payload)
          fragmentBytes += payload.length
          if (fragmentBytes > 1024 * 1024) {
            socket.destroy()
            return
          }
          if (fin) {
            if (fragmentOpcode === 0x1)
              handlers.onMessage?.(
                ws,
                Buffer.concat(fragments).toString('utf8'),
              )
            fragments = []
            fragmentBytes = 0
            fragmentOpcode = 0
          }
        }
      }
    })
    handlers.onOpen?.(ws)
    if (head.length) socket.emit('data', head)
  })
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
  } catch (error) {
    for (const socket of sockets) socket.destroy()
    server.closeAllConnections()
    server.close()
    throw error
  }
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw Error('Missing fixture port')
  }
  const { port } = address
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
