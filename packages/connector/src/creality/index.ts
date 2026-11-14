import WebSocket from 'ws'

export interface CrealityTelemetry {
  state?: 'idle' | 'printing' | 'paused' | 'error'
  nozzleTemp?: number
  nozzleTarget?: number
  bedTemp?: number
  bedTarget?: number
  progress?: number
  filename?: string
  layer?: number
  totalLayer?: number
  printDuration?: number
  estimatedRemainingSeconds?: number
  model?: string
  hostname?: string
  firmwareVersion?: string
}
export function decodeCrealityStatus(
  frame: string | Buffer,
  maxFrameBytes = 65536,
): CrealityTelemetry | undefined {
  if (Buffer.byteLength(frame) > maxFrameBytes) return
  let value: unknown
  try {
    value = JSON.parse(frame.toString())
  } catch {
    return
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const data = value as Record<string, unknown>
  const result: CrealityTelemetry = {}
  const states = ['idle', 'printing', 'paused'] as const
  if (typeof data.state === 'number' && states[data.state] !== undefined)
    result.state = states[data.state]
  if (typeof data.err === 'number' && data.err !== 0) result.state = 'error'
  for (const [source, target, max] of [
    ['nozzleTemp', 'nozzleTemp', 500],
    ['nozzleTemp2', 'nozzleTarget', 500],
    ['bedTemp', 'bedTemp', 200],
    ['bedTemp2', 'bedTarget', 200],
    ['printProgress', 'progress', 100],
    ['layer', 'layer', 1000000],
    ['TotalLayer', 'totalLayer', 1000000],
    ['printJobTime', 'printDuration', Number.MAX_SAFE_INTEGER],
    ['printLeftTime', 'estimatedRemainingSeconds', Number.MAX_SAFE_INTEGER],
  ] as const) {
    const n = data[source]
    if (
      typeof n === 'number' &&
      Number.isFinite(n) &&
      n >= 0 &&
      n <= max &&
      (!['layer', 'totalLayer'].includes(target) || Number.isInteger(n))
    )
      result[target] = n
  }
  // Stock firmware frame fields: https://github.com/DaviBe92/k2-websocket-re
  for (const [source, target, max] of [
    ['print', 'filename', 255],
    ['printFileName', 'filename', 255],
    ['model', 'model', 255],
    ['hostname', 'hostname', 255],
    ['modelVersion', 'firmwareVersion', 255],
  ] as const) {
    const value = data[source]
    if (
      typeof value === 'string' &&
      value.length <= max &&
      !/[\x00-\x1f\x7f-\x9f]/.test(value)
    )
      result[target] = value
  }
  return result
}

export function createCrealityTelemetryClient(options: {
  host: string
  port?: number
  onTelemetry: (report: CrealityTelemetry) => void
  reconnectDelayMs?: number
  maxReconnectDelayMs?: number
}) {
  const port = options.port ?? 9999
  const base = options.reconnectDelayMs ?? 500
  const cap = options.maxReconnectDelayMs ?? 30000
  if (
    !/^[a-zA-Z0-9.:-]+$/.test(options.host) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !Number.isFinite(base) ||
    base < 1 ||
    !Number.isFinite(cap) ||
    cap < base ||
    cap > 60000
  )
    throw new Error('Invalid Creality telemetry options')
  let stopped = false
  let attempt = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let socket: WebSocket
  let resolveDone: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  function connect() {
    const host = options.host.includes(':') ? `[${options.host}]` : options.host
    socket = new WebSocket(`ws://${host}:${port}`, {
      maxPayload: 65536,
      handshakeTimeout: 5000,
      perMessageDeflate: false,
    })
    socket.on('error', () => {})
    socket.on('message', (data, binary) => {
      if (stopped || binary) return
      const report = decodeCrealityStatus(data.toString())
      if (report) {
        try {
          options.onTelemetry(report)
        } catch {
          void close()
        }
      }
    })
    socket.once('close', () => {
      if (stopped) {
        resolveDone()
        return
      }
      timer = setTimeout(
        connect,
        Math.min(cap, base * 2 ** Math.min(attempt++, 20)),
      )
    })
  }
  function close() {
    if (!stopped) {
      stopped = true
      clearTimeout(timer)
      if (socket.readyState === WebSocket.CLOSED) resolveDone()
      else socket.terminate()
    }
    return done
  }
  connect()
  return { close, done }
}
