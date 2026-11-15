import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import type {
  WebSocket,
  WebSocketServer,
} from '../../packages/connector/node_modules/@types/ws'

/** What the simulated printer reports; journeys change it with `update`. */
export type PrinterModel = Readonly<{
  state: 'standby' | 'printing' | 'paused' | 'complete' | 'cancelled' | 'error'
  progress: number
  filename: string
  extruder: number
  bed: number
  fan: number
}>

export type MoonrakerSimulator = Readonly<{
  /** `http://127.0.0.1:<port>`: Moonraker (`/server/info`, `/websocket`). */
  origin: string
  /** `http://127.0.0.1:<port>`: an empty Spoolman inventory. */
  spoolmanOrigin: string
  model(): PrinterModel
  /** Applies a change and pushes it to every subscriber as Moonraker would. */
  update(patch: Partial<PrinterModel>): void
  /** JSON-RPC calls received, by method. */
  calls(): Readonly<Record<string, number>>
  close(): Promise<void>
}>

const OBJECTS = [
  'webhooks',
  'print_stats',
  'virtual_sdcard',
  'extruder',
  'heater_bed',
  'fan',
] as const

function statusOf(model: PrinterModel): Record<string, object> {
  return {
    webhooks: { state: 'ready' },
    print_stats: { state: model.state, filename: model.filename },
    virtual_sdcard: { progress: model.progress },
    extruder: { temperature: model.extruder },
    heater_bed: { temperature: model.bed },
    fan: { speed: model.fan },
  }
}

function pick(
  status: Record<string, object>,
  requested: unknown,
): Record<string, object> {
  if (!requested || typeof requested !== 'object') return {}
  const out: Record<string, object> = {}
  for (const [name, fields] of Object.entries(requested)) {
    const source = status[name] as Record<string, unknown> | undefined
    if (!source) continue
    out[name] = Array.isArray(fields)
      ? Object.fromEntries(
          fields.flatMap((field) =>
            typeof field === 'string' && field in source
              ? [[field, source[field]]]
              : [],
          ),
        )
      : source
  }
  return out
}

async function listen(server: Server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Simulator listener missing')
  return `http://127.0.0.1:${address.port}`
}

const closeServer = (server: Server) =>
  new Promise<void>((resolve, reject) => {
    server.closeAllConnections()
    server.close((error) => (error ? reject(error) : resolve()))
  })

/**
 * Loopback Moonraker speaking the read-only subset the Connector uses today:
 * `/server/info`, `printer.objects.list|subscribe|query` and
 * `notify_status_update`. Commands are not implemented, so none can reach a
 * printer. A Spoolman answering an empty inventory accompanies it.
 */
export async function startMoonrakerSimulator(
  initial: Partial<PrinterModel> = {},
): Promise<MoonrakerSimulator> {
  const {
    WebSocketServer: Sockets,
  }: { WebSocketServer: typeof WebSocketServer } = createRequire(
    new URL('../../packages/connector/package.json', import.meta.url),
  )('ws')
  let model: PrinterModel = {
    state: 'printing',
    progress: 0.25,
    filename: 'journey.gcode',
    extruder: 210,
    bed: 60,
    fan: 0.5,
    ...initial,
  }
  let eventtime = 1
  const calls: Record<string, number> = {}
  const sockets = new Sockets({
    noServer: true,
    maxPayload: 65536,
    perMessageDeflate: false,
  })
  const moonraker = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/server/info') {
      response.writeHead(404).end()
      return
    }
    response.setHeader('content-type', 'application/json')
    response.end(
      JSON.stringify({
        result: {
          klippy_connected: true,
          klippy_state: 'ready',
          moonraker_version: 'journey-simulator',
          websockets: sockets.clients.size,
        },
      }),
    )
  })
  moonraker.on('upgrade', (request, socket, head) => {
    if (request.url !== '/websocket') {
      socket.destroy()
      return
    }
    sockets.handleUpgrade(request, socket, head, (ws) =>
      sockets.emit('connection', ws, request),
    )
  })
  sockets.on('connection', (socket: WebSocket) => {
    socket.on('error', () => socket.terminate())
    socket.on('message', (data) => {
      let call: { id?: unknown; method?: unknown; params?: unknown }
      try {
        call = JSON.parse(data.toString('utf8'))
      } catch {
        socket.terminate()
        return
      }
      const method = typeof call.method === 'string' ? call.method : 'unknown'
      calls[method] = (calls[method] ?? 0) + 1
      const reply = (result: unknown) =>
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }))
      if (method === 'printer.objects.list') reply({ objects: [...OBJECTS] })
      else if (
        method === 'printer.objects.subscribe' ||
        method === 'printer.objects.query'
      ) {
        const requested = (call.params as { objects?: unknown } | undefined)
          ?.objects
        reply({
          eventtime,
          status: pick(statusOf(model), requested),
        })
      } else
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: call.id,
            error: { code: -32601, message: 'Method not found' },
          }),
        )
    })
  })
  const spoolman = createServer((request, response) => {
    if (request.method !== 'GET' || !request.url?.startsWith('/api/v1/spool')) {
      response.writeHead(404).end()
      return
    }
    response.setHeader('content-type', 'application/json')
    response.end('[]')
  })
  const [origin, spoolmanOrigin] = [
    await listen(moonraker),
    await listen(spoolman),
  ]
  return Object.freeze({
    origin,
    spoolmanOrigin,
    model: () => model,
    update(patch: Partial<PrinterModel>) {
      model = { ...model, ...patch }
      eventtime++
      const status = statusOf(model)
      for (const socket of sockets.clients)
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            method: 'notify_status_update',
            params: [status, eventtime],
          }),
        )
    },
    calls: () => ({ ...calls }),
    async close() {
      for (const socket of sockets.clients) socket.terminate()
      await new Promise<void>((resolve, reject) =>
        sockets.close((error) => (error ? reject(error) : resolve())),
      )
      await Promise.all([closeServer(moonraker), closeServer(spoolman)])
    },
  })
}
