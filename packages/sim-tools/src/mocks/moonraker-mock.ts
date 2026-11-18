// SPDX-License-Identifier: MIT
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { FaultController } from './faults.ts'
import { ScenarioController, type ScenarioStep } from './scenario.ts'

export type MoonrakerState =
  | 'standby'
  | 'printing'
  | 'paused'
  | 'complete'
  | 'cancelled'
  | 'error'

export interface MoonrakerModel {
  state: MoonrakerState
  progress: number
  filename: string
  extruder: number
  bed: number
  fan: number
}

export interface MoonrakerMockOptions {
  initial?: Partial<MoonrakerModel> | undefined
  scenario?: ScenarioStep<MoonrakerModel>[] | undefined
}

export interface MoonrakerMockInstance {
  origin: string
  ports: { default: number; http: number } & number[]
  control: {
    faults: FaultController
    scenario: ScenarioController<MoonrakerModel>
    update: (patch: Partial<MoonrakerModel>) => void
    model: () => MoonrakerModel
    sockets: Set<Duplex>
  }
  calls: {
    (): Readonly<Record<string, number>>
    all: readonly { method: string; params?: unknown; timestamp: number }[]
  }
  close: () => Promise<void>
}

const OBJECTS = [
  'webhooks',
  'print_stats',
  'virtual_sdcard',
  'extruder',
  'heater_bed',
  'fan',
] as const

function statusOf(model: MoonrakerModel): Record<string, object> {
  return {
    webhooks: { state: 'ready' },
    print_stats: { state: model.state, filename: model.filename },
    virtual_sdcard: { progress: model.progress },
    extruder: { temperature: model.extruder },
    heater_bed: { temperature: model.bed },
    fan: { speed: model.fan },
  }
}

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

export async function startMoonrakerMock(
  options: MoonrakerMockOptions = {},
): Promise<MoonrakerMockInstance> {
  const faults = new FaultController()
  const rawSockets = new Set<Duplex>()
  const wsSubscribers = new Set<(msg: string) => void>()
  const rpcCalls: { method: string; params?: unknown; timestamp: number }[] = []
  const callCounts: Record<string, number> = {}

  let model: MoonrakerModel = {
    state: 'standby',
    progress: 0,
    filename: '',
    extruder: 20,
    bed: 20,
    fan: 0,
    ...options.initial,
  }

  const recordCall = (key: string) => {
    callCounts[key] = (callCounts[key] ?? 0) + 1
  }

  function broadcastStatus(patch: Partial<MoonrakerModel>) {
    const notify = JSON.stringify({
      jsonrpc: '2.0',
      method: 'notify_status_update',
      params: [statusOf(model), Date.now() / 1000],
    })
    for (const send of wsSubscribers) {
      send(notify)
    }
  }

  function updateModel(patch: Partial<MoonrakerModel>) {
    model = { ...model, ...patch }
    broadcastStatus(patch)
  }

  const scenario = new ScenarioController<MoonrakerModel>({
    steps: options.scenario,
    applyState: (patch) => updateModel(patch),
    publishReport: () => broadcastStatus(model),
    getState: () => ({ ...model }),
  })

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!
    recordCall(`HTTP ${req.method} ${path}`)

    const fault = faults.matchFault({ path, method: req.method })
    if (fault) {
      if (fault.type === 'drop') {
        req.socket.destroy()
        return
      }
      if (fault.type === 'refuse') {
        res.writeHead(fault.statusCode ?? 503)
        res.end('Service Unavailable')
        return
      }
      if (fault.type === 'malformed') {
        req.socket.write('HTTP/1.1 999 GARBAGE\r\n\r\n')
        req.socket.destroy()
        return
      }
      if (fault.type === 'delay') {
        setTimeout(() => handleHttp(path, res), fault.delayMs)
        return
      }
      if (fault.type === 'stall') return
    }

    handleHttp(path, res)
  })

  function handleHttp(path: string, res: ServerResponse) {
    if (path === '/server/info') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          result: {
            klippy_state: 'ready',
            klippy_connected: true,
            components: ['spoolman'],
          },
        }),
      )
      return
    }

    if (path === '/printer/info') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          result: { state: 'ready', state_message: 'Printer is ready' },
        }),
      )
      return
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ result: 'ok' }))
  }

  server.on('connection', (sock) => {
    rawSockets.add(sock)
    sock.on('close', () => rawSockets.delete(sock))
  })

  server.on('upgrade', (req, socket, head) => {
    rawSockets.add(socket)
    socket.on('close', () => rawSockets.delete(socket))

    const key = req.headers['sec-websocket-key']
    if (typeof key !== 'string') {
      socket.destroy()
      return
    }

    const fault = faults.matchFault({ path: '/websocket', method: 'UPGRADE' })
    if (fault) {
      if (fault.type === 'drop') {
        socket.destroy()
        return
      }
      if (fault.type === 'refuse') {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }
    }

    const acceptKey = createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64')

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' +
        acceptKey +
        '\r\n\r\n',
    )

    const sendWs = (msg: string) => {
      if (socket.writable) {
        socket.write(frame(0x1, Buffer.from(msg)))
      }
    }

    wsSubscribers.add(sendWs)
    socket.once('close', () => wsSubscribers.delete(sendWs))

    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
      for (;;) {
        if (buffer.length < 2) return
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
        if (buffer.length < offset + length + (masked ? 4 : 0)) return
        const maskOffset = offset
        if (masked) offset += 4
        let payload = buffer.subarray(offset, offset + length)
        if (masked) {
          payload = Buffer.from(payload)
          for (let i = 0; i < payload.length; i++) {
            payload[i] = payload[i]! ^ buffer[maskOffset + (i % 4)]!
          }
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

        if (opcode === 0x1) {
          try {
            const raw = payload.toString('utf8')
            const req = JSON.parse(raw)
            if (req.method) {
              recordCall(req.method)
              rpcCalls.push({ method: req.method, params: req.params, timestamp: Date.now() })

              if (req.method === 'server.info') {
                sendWs(
                  JSON.stringify({
                    jsonrpc: '2.0',
                    id: req.id,
                    result: { klippy_state: 'ready', klippy_connected: true },
                  }),
                )
              } else if (req.method === 'printer.objects.list') {
                sendWs(
                  JSON.stringify({
                    jsonrpc: '2.0',
                    id: req.id,
                    result: { objects: OBJECTS },
                  }),
                )
              } else if (req.method === 'printer.objects.query' || req.method === 'printer.objects.subscribe') {
                sendWs(
                  JSON.stringify({
                    jsonrpc: '2.0',
                    id: req.id,
                    result: { status: statusOf(model) },
                  }),
                )
              } else {
                sendWs(
                  JSON.stringify({
                    jsonrpc: '2.0',
                    id: req.id,
                    result: 'ok',
                  }),
                )
              }
            }
          } catch {
            // ignore bad JSON
          }
        }
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const addr = server.address()
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to obtain Moonraker mock listening address')
  }

  const port = addr.port
  const origin = `http://127.0.0.1:${port}`

  const ports = Object.assign([port], {
    default: port,
    http: port,
  }) as { default: number; http: number } & number[]

  const callsFn = () => ({ ...callCounts })
  Object.defineProperty(callsFn, 'all', {
    get: () => rpcCalls,
  })

  const close = async () => {
    scenario.stop()
    wsSubscribers.clear()
    for (const s of rawSockets) {
      s.destroy()
    }
    rawSockets.clear()
    server.closeAllConnections()

    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  }

  return {
    origin,
    ports,
    control: {
      faults,
      scenario,
      update: updateModel,
      model: () => ({ ...model }),
      sockets: rawSockets,
    },
    calls: callsFn as any,
    close,
  }
}
