// SPDX-License-Identifier: MIT
import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import type { Socket } from 'node:net'
import { FaultController } from './faults.ts'
import { ScenarioController, type ScenarioStep } from './scenario.ts'

export interface HttpCallRecord {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body?: Buffer
  status: number
  timestamp: number
}

export type HttpHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
) => void | Promise<void>

export interface HttpMockOptions {
  handler?: HttpHandler | undefined
  routes?:
    | Record<
        string,
        (
          req: IncomingMessage,
          res: ServerResponse,
          body: Buffer,
        ) => void | Promise<void>
      >
    | undefined
  scenario?: ScenarioStep[] | undefined
  initialState?: Record<string, unknown> | undefined
}

export interface HttpMockInstance {
  origin: string
  ports: { default: number; http: number } & number[]
  control: {
    faults: FaultController
    scenario: ScenarioController
    setState: (patch: Record<string, unknown>) => void
    getState: () => Record<string, unknown>
    sockets: Set<Socket>
  }
  calls: {
    (): Readonly<Record<string, number>>
    all: readonly HttpCallRecord[]
  }
  close: () => Promise<void>
}

export async function startHttpMock(
  options: HttpMockOptions = {},
): Promise<HttpMockInstance> {
  const faults = new FaultController()
  const sockets = new Set<Socket>()
  const callRecords: HttpCallRecord[] = []
  const callCounts: Record<string, number> = {}
  let state: Record<string, unknown> = { ...(options.initialState ?? {}) }

  const recordCall = (key: string) => {
    callCounts[key] = (callCounts[key] ?? 0) + 1
  }

  const scenario = new ScenarioController({
    steps: options.scenario,
    applyState: (patch) => {
      state = { ...state, ...patch }
    },
    publishReport: () => {},
    getState: () => state,
  })

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', async () => {
      const body = Buffer.concat(chunks)
      const url = req.url ?? '/'
      const path = url.split('?')[0]!
      const method = req.method ?? 'GET'

      recordCall(method)
      recordCall(`${method} ${path}`)

      // Match fault hooks
      const fault = faults.matchFault({ path, method, headers: req.headers })
      if (fault) {
        if (fault.type === 'drop') {
          req.socket.destroy()
          return
        }
        if (fault.type === 'refuse') {
          const status = fault.statusCode ?? 503
          res.writeHead(status, { 'Content-Type': 'text/plain' })
          res.end(fault.message ?? 'Service Unavailable')
          callRecords.push({
            method,
            url,
            headers: req.headers,
            body,
            status,
            timestamp: Date.now(),
          })
          return
        }
        if (fault.type === 'malformed') {
          const bad = fault.payload ?? 'NOT_A_VALID_HTTP_RESPONSE\r\n\r\n'
          req.socket.write(bad)
          req.socket.destroy()
          return
        }
        if (fault.type === 'delay') {
          await new Promise((r) => setTimeout(r, fault.delayMs))
        }
        if (fault.type === 'stall') {
          // Never respond; keep socket open
          return
        }
      }

      let handled = false
      let statusCode = 200

      if (options.routes && options.routes[path]) {
        await options.routes[path](req, res, body)
        handled = true
      } else if (options.handler) {
        await options.handler(req, res, body)
        handled = true
      }

      if (!handled && !res.writableEnded) {
        statusCode = 200
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, state }))
      } else {
        statusCode = res.statusCode
      }

      callRecords.push({
        method,
        url,
        headers: req.headers,
        body,
        status: statusCode,
        timestamp: Date.now(),
      })
    })
  })

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
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
    throw new Error('Failed to obtain HTTP mock listening address')
  }

  const port = addr.port
  const origin = `http://127.0.0.1:${port}`

  const ports = Object.assign([port], {
    default: port,
    http: port,
  }) as { default: number; http: number } & number[]

  const callsFn = () => ({ ...callCounts })
  Object.defineProperty(callsFn, 'all', {
    get: () => callRecords,
  })

  const close = async () => {
    scenario.stop()
    for (const socket of sockets) {
      socket.destroy()
    }
    sockets.clear()
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
      setState: (patch) => {
        state = { ...state, ...patch }
      },
      getState: () => ({ ...state }),
      sockets,
    },
    calls: callsFn as any,
    close,
  }
}
