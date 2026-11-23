// SPDX-License-Identifier: MIT
import { createRequire } from 'node:module'
import https from 'node:https'
import type { RawData, WebSocket } from 'ws'
import { FaultController } from './mocks/faults.ts'
import { startHttpMock } from './mocks/http-mock.ts'
import { ScenarioController, type ScenarioStep } from './mocks/scenario.ts'

const require = createRequire(
  new URL('../../connector/package.json', import.meta.url),
)
const { WebSocketServer }: typeof import('ws') = require('ws')

export interface CrealitySimulatorOptions {
  /** Spec-derived, not captured: https://github.com/CrealityOfficial/CrealityPrint/blob/6262848e302b8c0d593f2b341cd01310aa2f58a1/src/slic3r/GUI/print_manage/AppUtils.cpp#L349-L352 */
  secure?:
    { key: string; cert: string; info?: Record<string, unknown> } | undefined
  durationMs?: number | undefined
  totalLayers?: number | undefined
  fail?: boolean | undefined
  /**
   * Re-sends the current status at this interval, as stock firmware keeps
   * pushing status while connected. Absent: frames only on change.
   */
  heartbeatMs?: number | undefined
  scenario?: ScenarioStep<Record<string, unknown>>[] | undefined
}

export async function createCrealitySimulator(
  initialFrame: object = { state: 0 },
  options: CrealitySimulatorOptions = {},
) {
  const faults = new FaultController()
  const received: string[] = []
  const requests: Array<{ method: string; params: Record<string, unknown> }> =
    []
  let currentFrame = { ...initialFrame } as Record<string, unknown>

  let uploaded: string | undefined
  /** Files stored over the stock HTTP upload (POST /upload/<name>). */
  const stored = new Map<string, number>()
  let timer: ReturnType<typeof setInterval> | undefined
  let elapsed = 0
  let lastTick = 0
  let closed = false
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>()
  const duration = Math.max(1, options.durationMs ?? 1000)
  const layers = Math.max(1, Math.floor(options.totalLayers ?? 10))

  const wss = new WebSocketServer({ noServer: true })

  function stopTimer() {
    if (timer) clearInterval(timer)
    timer = undefined
  }

  function disconnect() {
    for (const socket of wss.clients) socket.terminate()
  }

  function sendRaw(data: string, targets?: Iterable<WebSocket>) {
    const sockets = targets ?? wss.clients
    for (const client of sockets) {
      if (client.readyState === 1 /* OPEN */) {
        client.send(data)
      }
    }
  }

  async function challengeHeartbeat(timeoutMs = 1500) {
    const replies = await Promise.all(
      Array.from(wss.clients, (socket) => {
        if (socket.readyState !== socket.OPEN) return false
        return new Promise<boolean>((resolve) => {
          const finish = (acknowledged: boolean) => {
            clearTimeout(deadline)
            socket.off('message', onMessage)
            socket.off('close', onClose)
            resolve(acknowledged)
          }
          const onMessage = (data: RawData, binary: boolean) => {
            if (!binary && data.toString() === 'ok') finish(true)
          }
          const onClose = () => finish(false)
          const deadline = setTimeout(() => {
            socket.terminate()
            finish(false)
          }, timeoutMs)
          socket.on('message', onMessage)
          socket.once('close', onClose)
          socket.send(JSON.stringify({ ModeCode: 'heart_beat' }))
        })
      }),
    )
    return replies.filter(Boolean).length
  }

  function formatMalformed(payload?: Buffer | string): string {
    if (typeof payload === 'string') return payload
    if (Buffer.isBuffer(payload)) return payload.toString('utf8')
    return '{malformed'
  }

  function broadcast(payload: object, targets?: Iterable<WebSocket>) {
    const fault = faults.matchFault({ path: '/', method: 'REPORT' })
    if (fault) {
      if (fault.type === 'drop') {
        disconnect()
        return
      }
      if (fault.type === 'refuse' || fault.type === 'stall') {
        return
      }
      if (fault.type === 'malformed') {
        sendRaw(formatMalformed(fault.payload), targets)
        return
      }
      if (fault.type === 'delay') {
        const data = JSON.stringify(payload)
        const delayTimer = setTimeout(() => {
          pendingTimers.delete(delayTimer)
          if (!closed) sendRaw(data, targets)
        }, fault.delayMs)
        pendingTimers.add(delayTimer)
        return
      }
    }
    sendRaw(JSON.stringify(payload), targets)
  }

  function emitWithAckFault(payload: object) {
    const ackFault = faults.matchFault({ path: '/', method: 'ACK' })
    if (ackFault) {
      if (ackFault.type === 'drop') {
        disconnect()
        return
      }
      if (ackFault.type === 'refuse' || ackFault.type === 'stall') {
        return
      }
      if (ackFault.type === 'malformed') {
        sendRaw(formatMalformed(ackFault.payload))
        return
      }
      if (ackFault.type === 'delay') {
        const delayTimer = setTimeout(() => {
          pendingTimers.delete(delayTimer)
          if (!closed) broadcast(payload)
        }, ackFault.delayMs)
        pendingTimers.add(delayTimer)
        return
      }
    }
    broadcast(payload)
  }

  function startPrint(name: string) {
    elapsed = 0
    lastTick = Date.now()
    Object.assign(currentFrame, {
      state: 1,
      err: 0,
      filename: name,
      // Stock frame field names (the ones a client decodes).
      printFileName: name,
      printProgress: 0,
      layer: 0,
      totalLayer: layers,
      TotalLayer: layers,
    })
    emitWithAckFault(currentFrame)
    timer = setInterval(
      () => {
        const now = Date.now()
        if (currentFrame.state === 1) elapsed += now - lastTick
        lastTick = now
        if (currentFrame.state !== 1) return
        const fraction = Math.min(1, elapsed / duration)
        currentFrame.printProgress = Math.floor(fraction * 100)
        currentFrame.layer = Math.floor(fraction * layers)
        if (fraction === 1) {
          stopTimer()
          currentFrame.state = 0
          if (options.fail) currentFrame.err = 1
        }
        broadcast(currentFrame)
      },
      Math.max(1, Math.min(50, duration / 10)),
    )
  }

  function applyCommand(method: string, params: Record<string, unknown>) {
    requests.push({ method, params })
    if (!params) return
    if (
      method === 'upload' &&
      typeof params.filename === 'string' &&
      params.filename
    ) {
      uploaded = params.filename
      return
    }
    if (method === 'start' && uploaded && !timer) {
      startPrint(uploaded)
      return
    }
    if (method !== 'set') return

    // Stock start request (OrcaSlicer CrealityPrint): print a stored file.
    if (typeof params.opGcodeFile === 'string') {
      const name = params.opGcodeFile.replace(
        /^printprt:\/usr\/data\/printer_data\/gcodes\//,
        '',
      )
      const busy = currentFrame.state === 1 || currentFrame.state === 2
      if (stored.has(name) && !timer && !busy) startPrint(name)
      else emitWithAckFault(currentFrame)
      return
    }

    if (params.pause === 1) {
      currentFrame.state = 2 // paused
    } else if (params.pause === 0) {
      currentFrame.state = 1 // printing
    } else if (params.stop === 1) {
      stopTimer()
      currentFrame.state = 0 // idle
    }

    if (typeof params.nozzleTempControl === 'number') {
      currentFrame.nozzleTemp2 = params.nozzleTempControl
    }
    if (
      params.bedTempControl &&
      typeof (params.bedTempControl as { val?: unknown }).val === 'number'
    ) {
      currentFrame.bedTemp2 = (params.bedTempControl as { val: number }).val
    }
    if (typeof params.boxTempControl === 'number') {
      currentFrame.boxTemp2 = params.boxTempControl
    }

    // Fan switches also move the reported duty (stock status percentages).
    if (typeof params.fan === 'number') {
      currentFrame.fan = params.fan
      currentFrame.modelFanPct = params.fan ? 100 : 0
    }
    if (typeof params.fanAuxiliary === 'number') {
      currentFrame.fanAuxiliary = params.fanAuxiliary
      currentFrame.auxiliaryFanPct = params.fanAuxiliary ? 100 : 0
    }
    if (typeof params.fanCase === 'number') {
      currentFrame.fanCase = params.fanCase
      currentFrame.caseFanPct = params.fanCase ? 100 : 0
    }
    if (typeof params.lightSw === 'number') {
      currentFrame.lightSw = params.lightSw
    }
    if (typeof params.autohome === 'string') {
      currentFrame.autohome = params.autohome
    }

    emitWithAckFault(currentFrame)
  }

  wss.on('connection', (socket) => {
    socket.on('message', (data) => {
      const raw = data.toString()
      received.push(raw)
      const msgFault = faults.matchFault({ path: '/', method: 'PUBLISH' })
      if (msgFault) {
        if (msgFault.type === 'drop') {
          socket.terminate()
          return
        }
        if (msgFault.type === 'refuse' || msgFault.type === 'stall') {
          return
        }
        if (msgFault.type === 'delay') {
          const delayTimer = setTimeout(() => {
            pendingTimers.delete(delayTimer)
            if (closed) return
            try {
              const parsed = JSON.parse(raw)
              if (parsed && typeof parsed === 'object') {
                applyCommand(parsed.method, parsed.params)
              }
            } catch {
              // ignore malformed message in raw simulator stream
            }
          }, msgFault.delayMs)
          pendingTimers.add(delayTimer)
          return
        }
      }
      try {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object') {
          applyCommand(parsed.method, parsed.params)
        }
      } catch {
        // ignore malformed message in raw simulator stream
      }
    })
    broadcast(currentFrame, [socket])
  })

  const wsHttp = await startHttpMock({
    faults,
    onUpgrade: (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req)
      })
    },
  })

  const secureServer =
    options.secure &&
    https.createServer(
      { key: options.secure.key, cert: options.secure.cert },
      (req, res) => {
        if (req.method !== 'GET' || req.url !== '/info') {
          res.writeHead(404).end()
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            model: 'Simulator',
            mac: 'AA:BB:CC:00:00:01',
            wssPort: securePort,
            videoPort: 8000,
            ...options.secure?.info,
          }),
        )
      },
    )
  let securePort: number | undefined
  let secureConnections = 0
  if (secureServer) {
    secureServer.on('upgrade', (req, socket, head) => {
      secureConnections++
      wss.handleUpgrade(req, socket, head, (ws) =>
        wss.emit('connection', ws, req),
      )
    })
    await new Promise<void>((resolve) =>
      secureServer.listen(0, '127.0.0.1', resolve),
    )
    securePort = (secureServer.address() as { port: number }).port
  }

  // Stock HTTP upload: POST /upload/<name> with a multipart body. The body is
  // drained and counted, never parsed or kept.
  const uploadHttp = await startHttpMock({
    faults,
    handler: (request, response, body) => {
      const match = /^\/upload\/([^/?#]+)$/.exec(request.url ?? '')
      if (request.method !== 'POST' || !match) {
        response.writeHead(404).end()
        return
      }
      let name: string
      try {
        name = decodeURIComponent(match[1]!)
      } catch {
        response.writeHead(400).end()
        return
      }
      stored.set(name, body.length)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ code: 200 }))
    },
  })

  const heartbeat =
    options.heartbeatMs === undefined
      ? undefined
      : setInterval(
          () => {
            if (wss.clients.size > 0) broadcast(currentFrame)
          },
          Math.max(10, options.heartbeatMs),
        )

  const scenario = new ScenarioController<Record<string, unknown>>({
    steps: options.scenario,
    applyState: (patch) => {
      Object.assign(currentFrame, patch)
    },
    publishReport: (report) => {
      if (report && typeof report === 'object') {
        broadcast(report as object)
      } else if (typeof report === 'string') {
        sendRaw(report)
      }
    },
    getState: () => ({ ...currentFrame }),
  })

  const ports = Object.assign(
    [wsHttp.ports.default, uploadHttp.ports.default],
    {
      default: wsHttp.ports.default,
      ws: wsHttp.ports.default,
      http: uploadHttp.ports.default,
    },
  ) as { default: number; ws: number; http: number } & number[]

  let closing: Promise<void> | undefined

  return {
    port: wsHttp.ports.default,
    securePort,
    get secureConnections() {
      return secureConnections
    },
    /** Loopback port of the stock HTTP upload endpoint. */
    httpPort: uploadHttp.ports.default,
    origin: wsHttp.origin.replace(/^http:/, 'ws:'),
    ports,
    calls: wsHttp.calls,
    httpCalls: uploadHttp.calls,
    control: {
      faults,
      scenario,
      disconnect,
      setFrame(patch: object) {
        Object.assign(currentFrame, patch)
        broadcast(currentFrame)
      },
      emitFrame(frame: object) {
        broadcast(frame)
      },
      getState: () => ({ ...currentFrame }),
    },
    /** Names stored over HTTP, with the received body size in bytes. */
    get uploads() {
      return new Map(stored)
    },
    received,
    requests,
    get state() {
      return { ...currentFrame }
    },
    /** Journey control: merge into the current frame and broadcast it. */
    setFrame(patch: object) {
      Object.assign(currentFrame, patch)
      broadcast(currentFrame)
    },
    emitFrame(frame: object) {
      broadcast(frame)
    },
    /** One stock keepalive challenge per live peer. The reply is a text frame. */
    challengeHeartbeat,
    disconnect,
    close() {
      closed = true
      stopTimer()
      clearInterval(heartbeat)
      scenario.stop()
      for (const pending of pendingTimers) clearTimeout(pending)
      pendingTimers.clear()
      closing ??= (async () => {
        disconnect()
        await new Promise<void>((resolve, reject) =>
          wss.close((error: unknown) => (error ? reject(error) : resolve())),
        )
        await Promise.all([
          wsHttp.close(),
          uploadHttp.close(),
          ...(secureServer
            ? [
                new Promise<void>((resolve) =>
                  secureServer.close(() => resolve()),
                ),
              ]
            : []),
        ])
      })()
      return closing
    },
  }
}
