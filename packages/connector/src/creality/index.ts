import { boundPrinterString } from '@open3dfarmmanager/farm-protocol'
import WebSocket from 'ws'
import { resolveCrealityEndpoint } from '../discovery/creality.ts'

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
  fans?: { part?: number; aux?: number; chamber?: number }
  light?: { chamber?: boolean }
  materials?: Array<{
    slot: string
    materialType?: string
    colorHex?: string
    remainingPercent?: number
    active?: boolean
  }>
}
export function decodeCrealityStatus(
  frame: string | Buffer,
  maxFrameBytes = 65536,
): CrealityTelemetry | undefined {
  const data = parseCrealityFrame(frame, maxFrameBytes)
  if (data) return decodeCrealityFields(data)
}

function parseCrealityFrame(frame: string | Buffer, maxFrameBytes: number) {
  if (Buffer.byteLength(frame) > maxFrameBytes) return
  let value: unknown
  try {
    value = JSON.parse(frame.toString())
  } catch {
    return
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function decodeCrealityFields(
  data: Record<string, unknown>,
): CrealityTelemetry | undefined {
  const result: CrealityTelemetry = {}
  const states = ['idle', 'printing', 'paused'] as const
  if (typeof data.state === 'number' && states[data.state] !== undefined)
    result.state = states[data.state]!
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
      result[target] = target === 'filename' ? boundPrinterString(value) : value
  }
  // Stock :9999 status and boxsInfo wire shapes:
  // https://github.com/DaviBe92/k2-websocket-re
  const fans: NonNullable<CrealityTelemetry['fans']> = {}
  for (const [source, target] of [
    ['modelFanPct', 'part'],
    ['auxiliaryFanPct', 'aux'],
    ['caseFanPct', 'chamber'],
  ] as const) {
    const n = data[source]
    if (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 100)
      fans[target] = n
  }
  if (Object.keys(fans).length) result.fans = fans
  if (data.lightSw === 0 || data.lightSw === 1)
    result.light = { chamber: data.lightSw === 1 }
  const boxInfo = data.boxsInfo
  if (boxInfo && typeof boxInfo === 'object' && !Array.isArray(boxInfo)) {
    const boxes = (boxInfo as Record<string, unknown>).materialBoxs
    if (Array.isArray(boxes) && boxes.length <= 17) {
      const materials: NonNullable<CrealityTelemetry['materials']> = []
      const seen = new Set<string>()
      let valid = true
      for (const box of boxes) {
        if (!box || typeof box !== 'object' || Array.isArray(box)) {
          valid = false
          break
        }
        const b = box as Record<string, unknown>
        if (
          !Number.isInteger(b.id) ||
          (b.id as number) < 0 ||
          (b.id as number) > 4 ||
          !Array.isArray(b.materials) ||
          b.materials.length > 17
        ) {
          valid = false
          break
        }
        for (const entry of b.materials) {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            valid = false
            break
          }
          const m = entry as Record<string, unknown>
          if (
            !Number.isInteger(m.id) ||
            (m.id as number) < 0 ||
            (m.id as number) > 999
          ) {
            valid = false
            break
          }
          const slot = `${b.id}:${m.id}`
          if (seen.has(slot) || materials.length >= 17) {
            valid = false
            break
          }
          seen.add(slot)
          const material: NonNullable<CrealityTelemetry['materials']>[number] =
            { slot }
          if (
            typeof m.type === 'string' &&
            m.type.length > 0 &&
            m.type.length <= 64 &&
            !/[\x00-\x1f\x7f-\x9f]/.test(m.type)
          )
            material.materialType = boundPrinterString(m.type)
          if (typeof m.color === 'string') {
            const match = /^#(?:0)?([0-9a-f]{6})$/i.exec(m.color)
            if (match) material.colorHex = `${match[1]!.toUpperCase()}FF`
          }
          if (
            typeof m.percent === 'number' &&
            Number.isFinite(m.percent) &&
            m.percent >= 0 &&
            m.percent <= 100
          )
            material.remainingPercent = m.percent
          if (m.selected === 0 || m.selected === 1)
            material.active = m.selected === 1
          materials.push(material)
        }
        if (!valid) break
      }
      if (valid) result.materials = materials
    }
  }
  return result
}

export function createCrealityTelemetryClient(options: {
  host: string
  port?: number | undefined
  transport?: 'ws' | 'wss' | undefined
  httpsPort?: number | undefined
  caFile?: string | undefined
  onError?: (reason: string) => void
  onTelemetry: (report: CrealityTelemetry) => void
  onDisconnect?: () => void
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
  let socket: WebSocket | undefined
  let selectedEndpoint:
    Awaited<ReturnType<typeof resolveCrealityEndpoint>> | undefined
  let resolveDone: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  async function connect() {
    let endpoint: Awaited<ReturnType<typeof resolveCrealityEndpoint>>
    try {
      endpoint = selectedEndpoint ?? (await resolveCrealityEndpoint(options))
      selectedEndpoint = endpoint
    } catch (error) {
      if (stopped) return
      options.onError?.(error instanceof Error ? error.message : String(error))
      stopped = true
      resolveDone()
      return
    }
    if (stopped) return
    const host = options.host.includes(':') ? `[${options.host}]` : options.host
    const connection = new WebSocket(
      `${endpoint.secure ? 'wss' : 'ws'}://${host}:${endpoint.port}`,
      {
        ...(endpoint.ca ? { ca: endpoint.ca } : {}),
        maxPayload: 65536,
        handshakeTimeout: 5000,
        perMessageDeflate: false,
      },
    )
    socket = connection
    connection.on('error', () => {})
    connection.on('message', (data, binary) => {
      if (stopped || binary) return
      const frame = parseCrealityFrame(data.toString(), 65536)
      if (!frame) return
      // K1 LAN keepalive, source-read and hardware-unqualified.
      // https://github.com/OrcaSlicer/OrcaSlicer/blob/07f38df2a4fd3439cffbf991ee41ee99ec71fbee/src/slic3r/Utils/CrealityPrint.cpp#L303-L308
      // https://github.com/ChestnutLabs/printer-protocol-orchard/blob/fd5026ef9ec8b6b0f7b22884a2f2389e614c8fdf/protocols/creality.md#L56-L57
      if (frame.ModeCode === 'heart_beat') {
        if (connection.readyState === WebSocket.OPEN)
          connection.send('ok', (error) => {
            if (error) connection.terminate()
          })
        return
      }
      const report = decodeCrealityFields(frame)
      if (report) {
        try {
          options.onTelemetry(report)
        } catch {
          void close()
        }
      }
    })
    connection.once('close', () => {
      if (!stopped) options.onDisconnect?.()
      if (stopped) {
        resolveDone()
        return
      }
      timer = setTimeout(
        () => void connect(),
        Math.min(cap, base * 2 ** Math.min(attempt++, 20)),
      )
    })
  }
  function close() {
    if (!stopped) {
      stopped = true
      clearTimeout(timer)
      if (!socket || socket.readyState === WebSocket.CLOSED) resolveDone()
      else socket.terminate()
    }
    return done
  }
  void connect()
  return { close, done }
}
