import { createServer } from 'node:http'
import { createRequire } from 'node:module'

const require = createRequire(
  new URL('../../connector/package.json', import.meta.url),
)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { WebSocketServer } = require('ws') as any

export async function createCrealitySimulator(
  initialFrame: object = { state: 0 },
  options: {
    durationMs?: number
    totalLayers?: number
    fail?: boolean
    /**
     * Re-sends the current status at this interval, as stock firmware keeps
     * pushing status while connected. Absent: frames only on change.
     */
    heartbeatMs?: number
  } = {},
) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
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
  const duration = Math.max(1, options.durationMs ?? 1000)
  const layers = Math.max(1, Math.floor(options.totalLayers ?? 10))

  const heartbeat =
    options.heartbeatMs === undefined
      ? undefined
      : setInterval(
          () => broadcast(currentFrame),
          Math.max(10, options.heartbeatMs),
        )

  function stopTimer() {
    if (timer) clearInterval(timer)
    timer = undefined
  }

  function broadcast(payload: object) {
    const data = JSON.stringify(payload)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const client of server.clients as Set<any>) {
      if (client.readyState === 1 /* OPEN */) {
        client.send(data)
      }
    }
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
    broadcast(currentFrame)
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
      else broadcast(currentFrame)
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

    broadcast(currentFrame)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.on('connection', (socket: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    socket.on('message', (data: any) => {
      const raw = data.toString()
      received.push(raw)
      try {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object') {
          applyCommand(parsed.method, parsed.params)
        }
      } catch {
        // ignore malformed message in raw simulator stream
      }
    })
    socket.send(JSON.stringify(currentFrame))
  })

  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Missing address')

  // Stock HTTP upload: POST /upload/<name> with a multipart body. The body is
  // drained and counted, never parsed or kept.
  const http = createServer((request, response) => {
    const match = /^\/upload\/([^/?#]+)$/.exec(request.url ?? '')
    if (request.method !== 'POST' || !match) {
      request.resume()
      response.writeHead(404).end()
      return
    }
    let name: string
    try {
      name = decodeURIComponent(match[1]!)
    } catch {
      request.resume()
      response.writeHead(400).end()
      return
    }
    let bytes = 0
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length
    })
    request.on('end', () => {
      stored.set(name, bytes)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ code: 200 }))
    })
    request.on('error', () => response.destroy())
  })
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(0, '127.0.0.1', resolve)
  })
  const httpAddress = http.address()
  if (!httpAddress || typeof httpAddress === 'string')
    throw new Error('Missing HTTP address')

  return {
    port: address.port,
    /** Loopback port of the stock HTTP upload endpoint. */
    httpPort: httpAddress.port,
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
    disconnect() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const socket of server.clients as Set<any>) socket.terminate()
    },
    async close() {
      stopTimer()
      clearInterval(heartbeat)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const socket of server.clients as Set<any>) socket.terminate()
      await new Promise<void>((resolve, reject) =>
        server.close((error: unknown) => (error ? reject(error) : resolve())),
      )
      http.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      )
    },
  }
}
