// SPDX-License-Identifier: MIT
import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import type { Duplex } from 'node:stream'
import { FaultController } from './faults.ts'
import { ScenarioController, type ScenarioStep } from './scenario.ts'

export type MoonrakerProfile = 'sv06' | 'u1'

export type MoonrakerState =
  'standby' | 'printing' | 'paused' | 'complete' | 'cancelled' | 'error'
export type KlippyState =
  'ready' | 'startup' | 'shutdown' | 'error' | 'disconnected'

export interface MoonrakerExtruderState {
  temperature: number
  target: number
}

export interface MoonrakerModel {
  state: MoonrakerState
  progress: number
  filename: string
  extruder: number
  extruderTarget: number
  bed: number
  bedTarget: number
  fan: number
  chamber: number
  chamberTarget: number
  speedFactor: number
  caselight: number
  activeExtruder: string
  activeTool: number | undefined
  klippyState: KlippyState
  klippyConnected: boolean
  errorMessage: string
  printDuration: number
  totalDuration: number
  extruders: Record<string, MoonrakerExtruderState>
}

export interface MoonrakerThumbnailEntry {
  relativePath: string
  content: Buffer
  width?: number | undefined
  height?: number | undefined
}

export interface MoonrakerFileEntry {
  path: string
  size?: number | undefined
  modified?: number | undefined
  estimatedTime?: number | undefined
  content?: Buffer | string | undefined
  thumbnails?: readonly MoonrakerThumbnailEntry[] | undefined
}

export interface MoonrakerWebcamEntry {
  uid?: string | undefined
  name: string
  enabled?: boolean | undefined
  service?: string | undefined
  stream_url: string
  snapshot_url: string
  target_fps?: number | undefined
  rotation?: 0 | 90 | 180 | 270 | undefined
  flip_horizontal?: boolean | undefined
  flip_vertical?: boolean | undefined
}

export interface MoonrakerAuthConfig {
  username?: string | undefined
  password?: string | undefined
  apiKey?: string | undefined
  forceLogins?: boolean | undefined
  tokenTtlSeconds?: number | undefined
}

export interface MoonrakerFirmwareComponent {
  version: string
  remote_version?: string | undefined
  is_valid?: boolean | undefined
  update_available?: boolean | undefined
}

export interface MoonrakerMockOptions {
  profile?: MoonrakerProfile | undefined
  initial?: Partial<MoonrakerModel> | undefined
  scenario?: ScenarioStep<MoonrakerModel>[] | undefined
  objects?: readonly string[] | undefined
  macros?: readonly string[] | undefined
  webcams?: readonly MoonrakerWebcamEntry[] | undefined
  files?: readonly MoonrakerFileEntry[] | undefined
  auth?: MoonrakerAuthConfig | undefined
  firmware?:
    | {
        klipper?: MoonrakerFirmwareComponent | undefined
        moonraker?: MoonrakerFirmwareComponent | undefined
        system?: MoonrakerFirmwareComponent | undefined
      }
    | undefined
  spoolId?: number | null | undefined
  restartDelayMs?: number | undefined
  maxUploadBytes?: number | undefined
  maxWsConnections?: number | undefined
  maxRpcRequests?: number | undefined
  onMacroCall?: ((script: string) => void) | undefined
  onClientError?: ((error: Error) => void) | undefined
}

export interface StoredMoonrakerFile {
  path: string
  size: number
  modified: number
  estimatedTime?: number | undefined
  content: Buffer
  thumbnails: Map<string, MoonrakerThumbnailEntry>
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
    macroCalls: readonly { script: string; timestamp: number }[]
    gcodeScripts: readonly string[]
    files: Map<string, StoredMoonrakerFile>
    setKlippyState: (
      state: KlippyState,
      opts?: { connected?: boolean | undefined; message?: string | undefined },
    ) => void
    disconnectClients: () => void
    completePrint: () => void
    failPrint: (message?: string) => void
  }
  calls: {
    (): Readonly<Record<string, number>>
    all: readonly { method: string; params?: unknown; timestamp: number }[]
  }
  close: () => Promise<void>
}

const SV06_BASE_OBJECTS = [
  'webhooks',
  'print_stats',
  'virtual_sdcard',
  'display_status',
  'gcode_move',
  'toolhead',
  'save_variables',
  'extruder',
  'heater_bed',
  'fan',
] as const

const U1_EXTRA_OBJECTS = [
  'extruder1',
  'extruder2',
  'extruder3',
  'gcode_macro T0',
  'gcode_macro T1',
  'gcode_macro T2',
  'gcode_macro T3',
] as const

const DEFAULT_WEBCAMS: Record<
  MoonrakerProfile,
  readonly MoonrakerWebcamEntry[]
> = {
  sv06: [
    {
      uid: 'sv06-test-pattern',
      name: 'sv06-test-pattern',
      enabled: true,
      service: 'mjpegstreamer',
      stream_url: 'http://127.0.0.1:8110/?action=stream',
      snapshot_url: 'http://127.0.0.1:8110/?action=snapshot',
    },
  ],
  u1: [
    {
      uid: 'u1-test-pattern',
      name: 'u1-test-pattern',
      enabled: true,
      service: 'mjpegstreamer',
      stream_url: 'http://127.0.0.1:8111/?action=stream',
      snapshot_url: 'http://127.0.0.1:8111/?action=snapshot',
    },
  ],
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

function sendJson(res: ServerResponse, statusCode: number, body: unknown) {
  if (res.writableEnded) return
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function pickStatus(
  status: Record<string, object>,
  requested: unknown,
): Record<string, object> {
  if (requested === undefined || requested === null) return status
  if (typeof requested !== 'object' || Array.isArray(requested)) return {}
  const out: Record<string, object> = {}
  for (const [name, fields] of Object.entries(requested)) {
    const source = status[name] as Record<string, unknown> | undefined
    if (!source) continue
    if (
      fields === null ||
      fields === undefined ||
      (Array.isArray(fields) && fields.length === 0)
    ) {
      out[name] = source
    } else if (Array.isArray(fields)) {
      out[name] = Object.fromEntries(
        fields.flatMap((field) =>
          typeof field === 'string' && field in source
            ? [[field, source[field]]]
            : [],
        ),
      )
    }
  }
  return out
}

function parseQueryObjects(
  searchParams: URLSearchParams,
): Record<string, string[] | null> | undefined {
  const entries = [...searchParams.entries()]
  if (entries.length === 0) return undefined
  const out: Record<string, string[] | null> = {}
  for (const [key, value] of entries) {
    out[key] = value
      ? value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      : null
  }
  return out
}

function parseMultipartUpload(
  contentType: string,
  body: Buffer,
): {
  root: string
  filename: string | null
  content: Buffer
  startPrint: boolean
} {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)
  if (!match) throw new Error('Missing multipart boundary')
  const boundary = match[1] ?? match[2]!
  const delimiter = Buffer.from(`--${boundary}`)

  let root = 'gcodes'
  let filename: string | null = null
  let content = Buffer.alloc(0)
  let startPrint = false

  let cursor = body.indexOf(delimiter)
  while (cursor !== -1) {
    const afterDelimiter = cursor + delimiter.length
    if (body[afterDelimiter] === 0x2d && body[afterDelimiter + 1] === 0x2d) {
      break
    }
    const headerStart =
      body[afterDelimiter] === 0x0d && body[afterDelimiter + 1] === 0x0a
        ? afterDelimiter + 2
        : afterDelimiter
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), headerStart)
    if (headerEnd === -1) break

    const headerText = body.subarray(headerStart, headerEnd).toString('utf8')
    const dataStart = headerEnd + 4
    const nextDelimiter = body.indexOf(delimiter, dataStart)
    if (nextDelimiter === -1) break

    let dataEnd = nextDelimiter
    if (
      dataEnd >= dataStart + 2 &&
      body[dataEnd - 2] === 0x0d &&
      body[dataEnd - 1] === 0x0a
    ) {
      dataEnd -= 2
    }
    const partData = body.subarray(dataStart, dataEnd)

    const nameMatch = /\bname="([^"]+)"/i.exec(headerText)
    const fieldName = nameMatch?.[1]
    const fileMatch = /\bfilename="([^"]*)"/i.exec(headerText)

    if (fieldName === 'root') {
      const value = partData.toString('utf8').trim()
      if (value) root = value
    } else if (fieldName === 'print') {
      const value = partData.toString('utf8').trim().toLowerCase()
      startPrint = value === 'true' || value === '1'
    } else if (fieldName === 'file' || fileMatch) {
      filename = (fileMatch?.[1] ?? 'upload.gcode').replace(/[\r\n\\]/g, '_')
      content = Buffer.from(partData)
    }

    cursor = nextDelimiter
  }

  return { root, filename, content, startPrint }
}

function safeFilePath(raw: string): string | null {
  const decoded = decodeURIComponent(raw)
  if (
    !decoded ||
    decoded.includes('\\') ||
    /[\u0000-\u001f\u007f-\u009f]/.test(decoded)
  ) {
    return null
  }
  const parts = decoded.split('/')
  if (parts.some((p) => !p || p === '.' || p === '..')) return null
  return parts.join('/')
}

interface WsClient {
  connectionId: number
  socket: Duplex
  send: (msg: string) => void
  subscribedObjects: unknown | undefined
  hasSubscribed: boolean
}

export async function startMoonrakerMock(
  options: MoonrakerMockOptions = {},
): Promise<MoonrakerMockInstance> {
  const profile: MoonrakerProfile = options.profile ?? 'sv06'
  const faults = new FaultController()
  const rawSockets = new Set<Duplex>()
  const wsClients = new Set<WsClient>()
  const activeTimers = new Set<ReturnType<typeof setTimeout>>()
  const rpcCalls: { method: string; params?: unknown; timestamp: number }[] = []
  const macroCalls: { script: string; timestamp: number }[] = []
  const gcodeScripts: string[] = []
  const callCounts: Record<string, number> = {}

  const objectSet = new Set<string>(
    options.objects
      ? options.objects
      : [...SV06_BASE_OBJECTS, ...(profile === 'u1' ? U1_EXTRA_OBJECTS : [])],
  )
  for (const macro of options.macros ?? []) {
    objectSet.add(
      macro.startsWith('gcode_macro ') ? macro : `gcode_macro ${macro}`,
    )
  }
  const objectList = [...objectSet]

  const webcams = (options.webcams ?? DEFAULT_WEBCAMS[profile]).map((cam) => ({
    uid: cam.uid ?? cam.name,
    name: cam.name,
    enabled: cam.enabled ?? true,
    service: cam.service ?? 'mjpegstreamer',
    stream_url: cam.stream_url,
    snapshot_url: cam.snapshot_url,
    target_fps: cam.target_fps ?? 15,
    rotation: cam.rotation ?? 0,
    flip_horizontal: cam.flip_horizontal ?? false,
    flip_vertical: cam.flip_vertical ?? false,
  }))

  const genericFans = new Map<string, number>()
  const genericHeaters = new Map<string, MoonrakerExtruderState>()
  for (const obj of objectList) {
    if (obj.startsWith('fan_generic ')) {
      genericFans.set(obj.slice('fan_generic '.length), 0)
    } else if (obj.startsWith('heater_generic ')) {
      genericHeaters.set(obj.slice('heater_generic '.length), {
        temperature: 20,
        target: 0,
      })
    } else if (obj.startsWith('temperature_fan ')) {
      genericHeaters.set(obj.slice('temperature_fan '.length), {
        temperature: 20,
        target: 0,
      })
    }
  }

  const initialExtruderTemp = options.initial?.extruder ?? 20
  const initialExtruderTarget = options.initial?.extruderTarget ?? 0
  const initialExtruders: Record<string, MoonrakerExtruderState> = {
    extruder: {
      temperature: initialExtruderTemp,
      target: initialExtruderTarget,
    },
    ...(profile === 'u1' || objectSet.has('extruder1')
      ? { extruder1: { temperature: 20, target: 0 } }
      : {}),
    ...(profile === 'u1' || objectSet.has('extruder2')
      ? { extruder2: { temperature: 20, target: 0 } }
      : {}),
    ...(profile === 'u1' || objectSet.has('extruder3')
      ? { extruder3: { temperature: 20, target: 0 } }
      : {}),
    ...(options.initial?.extruders ?? {}),
  }

  let model: MoonrakerModel = {
    state: 'standby',
    progress: 0,
    filename: '',
    extruder: initialExtruderTemp,
    extruderTarget: initialExtruderTarget,
    bed: 20,
    bedTarget: 0,
    fan: 0,
    chamber: 20,
    chamberTarget: 0,
    speedFactor: 1,
    caselight: 0,
    activeExtruder: 'extruder',
    activeTool: profile === 'u1' ? 0 : undefined,
    klippyState: 'ready',
    klippyConnected: true,
    errorMessage: '',
    printDuration: 0,
    totalDuration: 0,
    ...options.initial,
    extruders: initialExtruders,
  }

  const filesMap = new Map<string, StoredMoonrakerFile>()
  for (const entry of options.files ?? []) {
    const buf =
      entry.content === undefined
        ? Buffer.from('; mock gcode\n')
        : typeof entry.content === 'string'
          ? Buffer.from(entry.content, 'utf8')
          : Buffer.from(entry.content)
    const thumbs = new Map<string, MoonrakerThumbnailEntry>()
    for (const thumb of entry.thumbnails ?? []) {
      thumbs.set(thumb.relativePath, {
        ...thumb,
        content: Buffer.from(thumb.content),
      })
    }
    filesMap.set(entry.path, {
      path: entry.path,
      size: entry.size ?? buf.length,
      modified: entry.modified ?? Math.floor(Date.now() / 1000),
      estimatedTime: entry.estimatedTime,
      content: buf,
      thumbnails: thumbs,
    })
  }

  const jwtSecret = randomBytes(32)
  const refreshTokens = new Set<string>()
  const oneshotTokens = new Set<string>()
  const activeTokens = new Set<string>()
  const authConfig = options.auth
  const authEnabled =
    authConfig !== undefined && authConfig.forceLogins !== false

  function issueJwt(username: string): string {
    const ttl = authConfig?.tokenTtlSeconds ?? 3600
    const exp = Math.floor(Date.now() / 1000) + ttl
    const header = Buffer.from(
      JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
    ).toString('base64url')
    const payload = Buffer.from(
      JSON.stringify({ sub: username, exp }),
    ).toString('base64url')
    const sig = createHmac('sha256', jwtSecret)
      .update(`${header}.${payload}`)
      .digest('base64url')
    const token = `${header}.${payload}.${sig}`
    activeTokens.add(token)
    return token
  }

  function verifyJwt(token: string): boolean {
    if (!activeTokens.has(token)) return false
    const parts = token.split('.')
    if (parts.length !== 3) return false
    const [header, payload, sig] = parts as [string, string, string]
    const expectedSig = createHmac('sha256', jwtSecret)
      .update(`${header}.${payload}`)
      .digest('base64url')
    const a = Buffer.from(sig)
    const b = Buffer.from(expectedSig)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false
    try {
      const decoded = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      ) as { exp?: unknown }
      return typeof decoded.exp === 'number' && decoded.exp > Date.now() / 1000
    } catch {
      return false
    }
  }

  function checkHttpAuth(
    req: IncomingMessage,
    url: URL,
    allowOneshot = false,
  ): { ok: boolean; token?: string } {
    if (!authEnabled) return { ok: true }
    const apiKeyHeader = req.headers['x-api-key']
    if (
      authConfig?.apiKey &&
      typeof apiKeyHeader === 'string' &&
      apiKeyHeader === authConfig.apiKey
    ) {
      return { ok: true }
    }
    const authHeader = req.headers.authorization
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      const bearer = authHeader.slice('Bearer '.length).trim()
      if (verifyJwt(bearer)) return { ok: true, token: bearer }
    }
    if (allowOneshot) {
      const oneshot = url.searchParams.get('token')
      if (oneshot && oneshotTokens.delete(oneshot)) {
        return { ok: true }
      }
    }
    return { ok: false }
  }

  let eventtime = 1
  let nextConnectionId = 0
  const maxUploadBytes = options.maxUploadBytes ?? 16 * 1024 * 1024
  const restartDelayMs = options.restartDelayMs ?? 30

  const recordCall = (key: string) => {
    callCounts[key] = (callCounts[key] ?? 0) + 1
  }

  function scheduleTimer(delayMs: number, fn: () => void) {
    const timer = setTimeout(() => {
      activeTimers.delete(timer)
      fn()
    }, delayMs)
    activeTimers.add(timer)
  }

  const isKlippyReady = () =>
    model.klippyConnected && model.klippyState === 'ready'

  function statusOf(m: MoonrakerModel): Record<string, object> {
    const all: Record<string, object> = {
      webhooks: {
        state: m.klippyState === 'disconnected' ? 'error' : m.klippyState,
        state_message:
          m.errorMessage ||
          (m.klippyState === 'ready'
            ? 'Printer is ready'
            : `Klippy ${m.klippyState}`),
      },
      print_stats: {
        state: m.state,
        filename: m.filename,
        print_duration: m.printDuration,
        total_duration: m.totalDuration,
        message: m.errorMessage,
      },
      virtual_sdcard: {
        progress: m.progress,
        is_active: m.state === 'printing' || m.state === 'paused',
        file_position: Math.round(m.progress * 1000),
      },
      display_status: {
        progress: m.progress,
        message: m.errorMessage,
      },
      gcode_move: {
        speed_factor: m.speedFactor,
        extrude_factor: 1,
      },
      toolhead: {
        extruder: m.activeExtruder,
      },
      save_variables: {
        variables:
          m.activeTool !== undefined ? { active_tool: m.activeTool } : {},
      },
      extruder: {
        temperature: m.extruders.extruder?.temperature ?? m.extruder,
        target: m.extruders.extruder?.target ?? m.extruderTarget,
        power: (m.extruders.extruder?.target ?? m.extruderTarget) > 0 ? 0.5 : 0,
      },
      heater_bed: {
        temperature: m.bed,
        target: m.bedTarget,
        power: m.bedTarget > 0 ? 0.5 : 0,
      },
      fan: {
        speed: m.fan,
      },
    }

    for (const obj of objectList) {
      if (obj in all) continue
      if (/^extruder[1-9]\d*$/.test(obj)) {
        const ext = m.extruders[obj] ?? { temperature: 20, target: 0 }
        all[obj] = {
          temperature: ext.temperature,
          target: ext.target,
          power: ext.target > 0 ? 0.5 : 0,
        }
      } else if (obj === 'output_pin caselight') {
        all[obj] = { value: m.caselight }
      } else if (obj.startsWith('fan_generic ')) {
        const name = obj.slice('fan_generic '.length)
        all[obj] = { speed: genericFans.get(name) ?? 0 }
      } else if (
        obj.startsWith('heater_generic ') ||
        obj.startsWith('temperature_fan ')
      ) {
        const name = obj.slice(obj.indexOf(' ') + 1)
        const heater = genericHeaters.get(name) ?? {
          temperature: m.chamber,
          target: m.chamberTarget,
        }
        all[obj] = { temperature: heater.temperature, target: heater.target }
      } else if (
        obj.startsWith('led ') ||
        obj.startsWith('neopixel ') ||
        obj.startsWith('dotstar ') ||
        obj.startsWith('pca9533 ') ||
        obj.startsWith('pca9632 ')
      ) {
        all[obj] = {
          color_data: [[m.caselight, m.caselight, m.caselight, 0]],
        }
      }
    }

    return all
  }

  function broadcastStatus() {
    eventtime++
    const current = statusOf(model)
    for (const client of wsClients) {
      if (!client.hasSubscribed) continue
      const delta = pickStatus(current, client.subscribedObjects)
      client.send(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'notify_status_update',
          params: [delta, eventtime],
        }),
      )
    }
  }

  function broadcastKlippyNotification(method: string) {
    const msg = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params: [],
    })
    for (const client of wsClients) {
      client.send(msg)
    }
  }

  function updateModel(patch: Partial<MoonrakerModel>) {
    const nextExtruders = {
      ...model.extruders,
      ...(patch.extruders ?? {}),
    }
    if (patch.extruder !== undefined || patch.extruderTarget !== undefined) {
      nextExtruders.extruder = {
        temperature:
          patch.extruder ??
          nextExtruders.extruder?.temperature ??
          model.extruder,
        target:
          patch.extruderTarget ??
          nextExtruders.extruder?.target ??
          model.extruderTarget,
      }
    }
    model = {
      ...model,
      ...patch,
      extruders: nextExtruders,
    }
    broadcastStatus()
  }

  function setKlippyState(
    nextState: KlippyState,
    opts?: { connected?: boolean | undefined; message?: string | undefined },
  ) {
    const prevState = model.klippyState
    model = {
      ...model,
      klippyState: nextState,
      klippyConnected: opts?.connected ?? nextState !== 'disconnected',
      ...(opts?.message !== undefined ? { errorMessage: opts.message } : {}),
    }
    if (nextState !== prevState) {
      if (nextState === 'shutdown')
        broadcastKlippyNotification('notify_klippy_shutdown')
      else if (nextState === 'disconnected')
        broadcastKlippyNotification('notify_klippy_disconnected')
      else if (nextState === 'ready')
        broadcastKlippyNotification('notify_klippy_ready')
    }
  }

  function triggerRestart() {
    model = {
      ...model,
      activeExtruder: 'extruder',
    }
    if (restartDelayMs > 0) {
      model = { ...model, klippyState: 'startup', klippyConnected: true }
      scheduleTimer(restartDelayMs, () => {
        model = { ...model, klippyState: 'ready', klippyConnected: true }
        broadcastKlippyNotification('notify_klippy_ready')
      })
    } else {
      model = { ...model, klippyState: 'ready', klippyConnected: true }
    }
  }

  function executeGcode(script: string) {
    macroCalls.push({ script, timestamp: Date.now() })
    gcodeScripts.push(script)
    options.onMacroCall?.(script)

    const patch: Partial<MoonrakerModel> = {}
    let touchedExtruder = false
    const nextExtruders = { ...model.extruders }

    for (const rawLine of script.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line) continue
      const upper = line.toUpperCase()

      const toolMatch = /^T([0-9]+)$/.exec(upper)
      if (toolMatch) {
        const tool = Number(toolMatch[1])
        const extName = tool === 0 ? 'extruder' : `extruder${tool}`
        if (objectSet.has(extName) || objectSet.has(`gcode_macro T${tool}`)) {
          patch.activeExtruder = extName
          patch.activeTool = tool
        }
        continue
      }

      const activateMatch =
        /^ACTIVATE_EXTRUDER\s+EXTRUDER=([A-Za-z0-9_]+)/i.exec(line)
      if (activateMatch) {
        patch.activeExtruder = activateMatch[1]!
        continue
      }

      const saveVarMatch =
        /^SAVE_VARIABLE\s+VARIABLE=active_tool\s+VALUE=(\d+)/i.exec(line)
      if (saveVarMatch) {
        patch.activeTool = Number(saveVarMatch[1])
        continue
      }

      if (upper.startsWith('SET_HEATER_TEMPERATURE ')) {
        const heaterMatch = /HEATER=([A-Za-z0-9_]+)/i.exec(line)
        const targetMatch = /TARGET=(-?\d+(?:\.\d+)?)/i.exec(line)
        if (heaterMatch && targetMatch) {
          const heater = heaterMatch[1]!
          const target = Number(targetMatch[1])
          if (heater === 'extruder' || /^extruder\d+$/.test(heater)) {
            nextExtruders[heater] = {
              temperature: nextExtruders[heater]?.temperature ?? model.extruder,
              target,
            }
            touchedExtruder = true
            if (heater === 'extruder') patch.extruderTarget = target
          } else if (heater === 'heater_bed') {
            patch.bedTarget = target
          } else if (heater === 'chamber') {
            patch.chamberTarget = target
            genericHeaters.set('chamber', {
              temperature:
                genericHeaters.get('chamber')?.temperature ?? model.chamber,
              target,
            })
          } else {
            genericHeaters.set(heater, {
              temperature: genericHeaters.get(heater)?.temperature ?? 20,
              target,
            })
          }
        }
        continue
      }

      if (upper.startsWith('SET_TEMPERATURE_FAN_TARGET ')) {
        const fanMatch = /TEMPERATURE_FAN=([A-Za-z0-9_]+)/i.exec(line)
        const targetMatch = /TARGET=(-?\d+(?:\.\d+)?)/i.exec(line)
        if (fanMatch && targetMatch) {
          const name = fanMatch[1]!
          const target = Number(targetMatch[1])
          if (name === 'chamber') patch.chamberTarget = target
          genericHeaters.set(name, {
            temperature: genericHeaters.get(name)?.temperature ?? 20,
            target,
          })
        }
        continue
      }

      const m104 = /^(?:M104|M109)\s+S(\d+(?:\.\d+)?)/.exec(upper)
      if (m104) {
        const target = Number(m104[1])
        patch.extruderTarget = target
        nextExtruders[model.activeExtruder] = {
          temperature:
            nextExtruders[model.activeExtruder]?.temperature ?? model.extruder,
          target,
        }
        touchedExtruder = true
        continue
      }

      const m140 = /^(?:M140|M190)\s+S(\d+(?:\.\d+)?)/.exec(upper)
      if (m140) {
        patch.bedTarget = Number(m140[1])
        continue
      }

      const m106 = /^M106\s+S(\d+(?:\.\d+)?)/.exec(upper)
      if (m106) {
        patch.fan = Math.min(1, Math.max(0, Number(m106[1]) / 255))
        continue
      }
      if (upper === 'M107') {
        patch.fan = 0
        continue
      }

      if (upper.startsWith('SET_FAN_SPEED ')) {
        const fanMatch = /FAN=([A-Za-z0-9_]+)/i.exec(line)
        const speedMatch = /SPEED=(\d+(?:\.\d+)?)/i.exec(line)
        if (fanMatch && speedMatch) {
          genericFans.set(
            fanMatch[1]!,
            Math.min(1, Math.max(0, Number(speedMatch[1]))),
          )
        }
        continue
      }

      if (upper.startsWith('SET_PIN ')) {
        const pinMatch = /PIN=([A-Za-z0-9_]+)/i.exec(line)
        const valMatch = /VALUE=(\d+(?:\.\d+)?)/i.exec(line)
        if (pinMatch?.[1]?.toLowerCase() === 'caselight' && valMatch) {
          patch.caselight = Number(valMatch[1])
        }
        continue
      }

      if (upper.startsWith('SET_LED ')) {
        const whiteMatch = /WHITE=(\d+(?:\.\d+)?)/i.exec(line)
        if (whiteMatch) patch.caselight = Number(whiteMatch[1])
        continue
      }

      const m220 = /^M220\s+S(\d+(?:\.\d+)?)/.exec(upper)
      if (m220) {
        patch.speedFactor = Number(m220[1]) / 100
        continue
      }

      if (upper === 'PAUSE') patch.state = 'paused'
      else if (upper === 'RESUME') patch.state = 'printing'
      else if (upper === 'CANCEL_PRINT') {
        patch.state = 'cancelled'
        patch.progress = 0
      }
    }

    if (touchedExtruder) patch.extruders = nextExtruders
    if (Object.keys(patch).length > 0) {
      updateModel(patch)
    }
  }

  function firmwareVersionInfo() {
    const klipper = options.firmware?.klipper ?? {
      version: 'v0.12.0-sim',
      remote_version: 'v0.12.0-sim',
      is_valid: true,
      update_available: false,
    }
    const moonraker = options.firmware?.moonraker ?? {
      version: 'v0.9.3-sim',
      remote_version: 'v0.9.3-sim',
      is_valid: true,
      update_available: false,
    }
    return {
      klipper,
      moonraker,
      ...(options.firmware?.system ? { system: options.firmware.system } : {}),
    }
  }

  function serverInfoResult() {
    return {
      klippy_connected: model.klippyConnected,
      klippy_state: model.klippyState,
      moonraker_version: 'v0.9.3-mock',
      api_version: [1, 5, 0],
      api_version_string: '1.5.0',
      components: [
        'file_manager',
        'history',
        'spoolman',
        'update_manager',
        'webcam',
        ...(authConfig ? ['authorization'] : []),
      ],
      websockets: wsClients.size,
      websockets_count: wsClients.size,
    }
  }

  function fileListResult() {
    return [...filesMap.values()].map((f) => ({
      path: f.path,
      size: f.size,
      modified: f.modified,
      permissions: 'rw',
    }))
  }

  function fileMetadataResult(filename: string) {
    const file = filesMap.get(filename)
    if (!file) return null
    return {
      filename: file.path,
      size: file.size,
      modified: file.modified,
      ...(file.estimatedTime !== undefined
        ? { estimated_time: file.estimatedTime }
        : {}),
      ...(file.thumbnails.size > 0
        ? {
            thumbnails: [...file.thumbnails.values()].map((t) => ({
              relative_path: t.relativePath,
              size: t.content.length,
              ...(t.width !== undefined ? { width: t.width } : {}),
              ...(t.height !== undefined ? { height: t.height } : {}),
            })),
          }
        : {}),
    }
  }

  const scenario = new ScenarioController<MoonrakerModel>({
    steps: options.scenario,
    applyState: (patch) => updateModel(patch),
    publishReport: () => broadcastStatus(),
    getState: () => ({ ...model }),
  })

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    const method = (req.method ?? 'GET').toUpperCase()
    recordCall(`HTTP ${method} ${path}`)

    const chunks: Buffer[] = []
    let receivedBytes = 0
    let abortedTooLarge = false

    req.on('data', (chunk: Buffer) => {
      receivedBytes += chunk.length
      if (receivedBytes > maxUploadBytes + 64 * 1024) {
        abortedTooLarge = true
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      const body = abortedTooLarge ? Buffer.alloc(0) : Buffer.concat(chunks)

      const fault = faults.matchFault({ path, method, headers: req.headers })
      if (fault) {
        if (fault.type === 'drop') {
          req.socket.destroy()
          return
        }
        if (fault.type === 'refuse') {
          res.writeHead(fault.statusCode ?? 503, {
            'Content-Type': 'text/plain',
          })
          res.end(fault.message ?? 'Service Unavailable')
          return
        }
        if (fault.type === 'malformed') {
          req.socket.write(fault.payload ?? 'HTTP/1.1 999 GARBAGE\r\n\r\n')
          req.socket.destroy()
          return
        }
        if (fault.type === 'delay') {
          scheduleTimer(fault.delayMs, () => {
            if (!req.socket.destroyed && !res.writableEnded) {
              handleHttp(req, res, url, path, method, body, abortedTooLarge)
            }
          })
          return
        }
        if (fault.type === 'stall') return
      }

      handleHttp(req, res, url, path, method, body, abortedTooLarge)
    })
  })

  function handleHttp(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    path: string,
    method: string,
    body: Buffer,
    abortedTooLarge: boolean,
  ) {
    // Auth endpoints
    if (path === '/access/login' && method === 'POST') {
      try {
        const parsed = JSON.parse(body.toString('utf8')) as {
          username?: unknown
          password?: unknown
        }
        const expectedUser = authConfig?.username
        const expectedPass = authConfig?.password
        if (
          typeof parsed.username !== 'string' ||
          typeof parsed.password !== 'string' ||
          (expectedUser !== undefined && parsed.username !== expectedUser) ||
          (expectedPass !== undefined && parsed.password !== expectedPass)
        ) {
          sendJson(res, 401, {
            error: { code: 401, message: 'Invalid username or password' },
          })
          return
        }
        const token = issueJwt(parsed.username)
        const refreshToken = randomBytes(24).toString('hex')
        refreshTokens.add(refreshToken)
        sendJson(res, 200, {
          result: {
            username: parsed.username,
            token,
            refresh_token: refreshToken,
            action: 'user_logged_in',
            source: 'moonraker',
          },
        })
      } catch {
        sendJson(res, 400, { error: { code: 400, message: 'Invalid JSON' } })
      }
      return
    }

    if (path === '/access/refresh_jwt' && method === 'POST') {
      const authHeader = req.headers.authorization
      const bearer =
        typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
          ? authHeader.slice('Bearer '.length).trim()
          : ''
      if (!bearer || !refreshTokens.has(bearer)) {
        sendJson(res, 401, {
          error: { code: 401, message: 'Invalid refresh token' },
        })
        return
      }
      const token = issueJwt(authConfig?.username ?? 'user')
      sendJson(res, 200, { result: { token } })
      return
    }

    const authCheck = checkHttpAuth(req, url, path.startsWith('/server/files/'))
    if (!authCheck.ok) {
      sendJson(res, 401, { error: { code: 401, message: 'Unauthorized' } })
      return
    }

    if (
      path === '/access/oneshot_token' &&
      (method === 'GET' || method === 'POST')
    ) {
      const shot = randomBytes(16).toString('hex')
      oneshotTokens.add(shot)
      sendJson(res, 200, { result: shot })
      return
    }

    if (path === '/access/logout' && method === 'POST') {
      if (authCheck.token) activeTokens.delete(authCheck.token)
      refreshTokens.clear()
      sendJson(res, 200, {
        result: {
          username: authConfig?.username ?? 'user',
          action: 'user_logged_out',
        },
      })
      return
    }

    // Server info & status
    if (path === '/server/info' && method === 'GET') {
      sendJson(res, 200, { result: serverInfoResult() })
      return
    }

    if (path === '/printer/info' && method === 'GET') {
      if (!model.klippyConnected || model.klippyState === 'disconnected') {
        sendJson(res, 503, {
          error: { code: 503, message: 'Klippy Host not connected' },
        })
        return
      }
      sendJson(res, 200, {
        result: {
          state: model.klippyState,
          state_message:
            model.errorMessage ||
            (model.klippyState === 'ready'
              ? 'Printer is ready'
              : `Klippy ${model.klippyState}`),
          hostname: profile === 'u1' ? 'u1-mock' : 'sv06-mock',
        },
      })
      return
    }

    if (path === '/server/webcams/list' && method === 'GET') {
      sendJson(res, 200, { result: { webcams } })
      return
    }

    if (path === '/machine/update/status' && method === 'GET') {
      sendJson(res, 200, { result: { version_info: firmwareVersionInfo() } })
      return
    }

    if (path === '/server/spoolman/spool_id' && method === 'GET') {
      sendJson(res, 200, { result: { spool_id: options.spoolId ?? null } })
      return
    }

    // Files
    if (path === '/server/files/list' && method === 'GET') {
      sendJson(res, 200, { result: fileListResult() })
      return
    }

    if (path === '/server/files/metadata' && method === 'GET') {
      const filename = url.searchParams.get('filename') ?? ''
      const meta = fileMetadataResult(filename)
      if (!meta) {
        sendJson(res, 404, { error: { code: 404, message: 'File not found' } })
        return
      }
      sendJson(res, 200, { result: meta })
      return
    }

    if (path === '/server/files/upload' && method === 'POST') {
      if (abortedTooLarge) {
        sendJson(res, 413, {
          error: { code: 413, message: 'File exceeds maximum size' },
        })
        return
      }
      const contentType = req.headers['content-type'] ?? ''
      if (!contentType.includes('multipart/form-data')) {
        sendJson(res, 400, {
          error: { code: 400, message: 'Expected multipart/form-data' },
        })
        return
      }
      try {
        const parsed = parseMultipartUpload(contentType, body)
        if (!parsed.filename) {
          sendJson(res, 400, {
            error: { code: 400, message: 'Missing uploaded file' },
          })
          return
        }
        if (parsed.content.length > maxUploadBytes) {
          sendJson(res, 413, {
            error: { code: 413, message: 'File exceeds maximum size' },
          })
          return
        }
        const safe = safeFilePath(parsed.filename)
        if (!safe) {
          sendJson(res, 400, {
            error: { code: 400, message: 'Invalid filename' },
          })
          return
        }
        const entry: StoredMoonrakerFile = {
          path: safe,
          size: parsed.content.length,
          modified: Math.floor(Date.now() / 1000),
          content: parsed.content,
          thumbnails: new Map(),
        }
        filesMap.set(safe, entry)
        if (parsed.startPrint && isKlippyReady()) {
          updateModel({
            state: 'printing',
            filename: safe,
            progress: 0,
            errorMessage: '',
          })
        }
        sendJson(res, 201, {
          result: {
            item: { path: safe, root: parsed.root },
            action: 'create_file',
          },
        })
      } catch {
        sendJson(res, 400, {
          error: { code: 400, message: 'Malformed multipart upload' },
        })
      }
      return
    }

    if (path.startsWith('/server/files/gcodes/')) {
      const rel = safeFilePath(path.slice('/server/files/gcodes/'.length))
      if (!rel) {
        sendJson(res, 400, { error: { code: 400, message: 'Invalid path' } })
        return
      }
      if (method === 'DELETE') {
        const existed = filesMap.delete(rel)
        if (!existed) {
          sendJson(res, 404, { error: { code: 404, message: 'Not found' } })
          return
        }
        sendJson(res, 200, {
          result: {
            item: { path: rel, root: 'gcodes' },
            action: 'delete_file',
          },
        })
        return
      }
      if (method === 'GET') {
        const direct = filesMap.get(rel)
        if (direct) {
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': direct.content.length,
          })
          res.end(direct.content)
          return
        }
        for (const file of filesMap.values()) {
          const dir = file.path.includes('/')
            ? file.path.slice(0, file.path.lastIndexOf('/') + 1)
            : ''
          if (!rel.startsWith(dir)) continue
          const thumbRel = rel.slice(dir.length)
          const thumb = file.thumbnails.get(thumbRel)
          if (thumb) {
            res.writeHead(200, {
              'Content-Type': 'image/png',
              'Content-Length': thumb.content.length,
            })
            res.end(thumb.content)
            return
          }
        }
        sendJson(res, 404, { error: { code: 404, message: 'File not found' } })
        return
      }
    }

    // Restart commands work even when Klippy is shutdown/error
    if (
      (path === '/printer/restart' || path === '/printer/firmware_restart') &&
      method === 'POST'
    ) {
      triggerRestart()
      sendJson(res, 200, { result: 'ok' })
      return
    }

    // Klipper-dependent endpoints
    if (!isKlippyReady()) {
      sendJson(res, 503, {
        error: { code: 503, message: 'Klippy Host is not ready' },
      })
      return
    }

    if (
      path === '/printer/objects/list' &&
      (method === 'GET' || method === 'POST')
    ) {
      sendJson(res, 200, { result: { objects: [...objectList] } })
      return
    }

    if (
      path === '/printer/objects/query' &&
      (method === 'GET' || method === 'POST')
    ) {
      let requested: unknown = parseQueryObjects(url.searchParams)
      if (method === 'POST' && body.length > 0) {
        try {
          const parsed = JSON.parse(body.toString('utf8')) as {
            objects?: unknown
          }
          if (parsed.objects !== undefined) requested = parsed.objects
        } catch {
          sendJson(res, 400, { error: { code: 400, message: 'Invalid JSON' } })
          return
        }
      }
      eventtime++
      sendJson(res, 200, {
        result: {
          eventtime,
          status: pickStatus(statusOf(model), requested),
        },
      })
      return
    }

    if (
      path === '/printer/gcode/script' &&
      (method === 'GET' || method === 'POST')
    ) {
      let script = url.searchParams.get('script') ?? ''
      if (method === 'POST' && body.length > 0) {
        try {
          const parsed = JSON.parse(body.toString('utf8')) as {
            script?: unknown
          }
          if (typeof parsed.script === 'string') script = parsed.script
        } catch {
          sendJson(res, 400, { error: { code: 400, message: 'Invalid JSON' } })
          return
        }
      }
      if (script) executeGcode(script)
      sendJson(res, 200, { result: 'ok' })
      return
    }

    if (path === '/printer/print/start' && method === 'POST') {
      let filename = url.searchParams.get('filename') ?? model.filename
      if (body.length > 0) {
        try {
          const parsed = JSON.parse(body.toString('utf8')) as {
            filename?: unknown
          }
          if (typeof parsed.filename === 'string') filename = parsed.filename
        } catch {
          sendJson(res, 400, { error: { code: 400, message: 'Invalid JSON' } })
          return
        }
      }
      updateModel({
        state: 'printing',
        filename,
        progress: 0,
        errorMessage: '',
      })
      sendJson(res, 200, { result: 'ok' })
      return
    }

    if (path === '/printer/print/pause' && method === 'POST') {
      updateModel({ state: 'paused' })
      sendJson(res, 200, { result: 'ok' })
      return
    }

    if (path === '/printer/print/resume' && method === 'POST') {
      updateModel({ state: 'printing' })
      sendJson(res, 200, { result: 'ok' })
      return
    }

    if (path === '/printer/print/cancel' && method === 'POST') {
      updateModel({ state: 'cancelled', progress: 0 })
      sendJson(res, 200, { result: 'ok' })
      return
    }

    if (path === '/printer/emergency_stop' && method === 'POST') {
      updateModel({
        state: 'error',
        extruderTarget: 0,
        bedTarget: 0,
        fan: 0,
        errorMessage: 'Emergency stop',
      })
      sendJson(res, 200, { result: 'ok' })
      return
    }

    sendJson(res, 404, { error: { code: 404, message: 'Not Found' } })
  }

  server.on('connection', (sock) => {
    rawSockets.add(sock)
    sock.on('error', () => {
      rawSockets.delete(sock)
      sock.destroy()
    })
    sock.on('close', () => rawSockets.delete(sock))
  })

  server.on('upgrade', (req, socket) => {
    rawSockets.add(socket)
    socket.on('close', () => rawSockets.delete(socket))

    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/websocket') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    if (
      options.maxWsConnections !== undefined &&
      wsClients.size >= options.maxWsConnections
    ) {
      socket.destroy()
      return
    }

    if (!checkHttpAuth(req, url, true).ok) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

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
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      if (fault.type === 'malformed') {
        socket.write(fault.payload ?? 'NOT_WEBSOCKET\r\n\r\n')
        socket.destroy()
        return
      }
      if (fault.type === 'stall') {
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

    const connectionId = ++nextConnectionId
    const client: WsClient = {
      connectionId,
      socket,
      send: () => {},
      subscribedObjects: undefined,
      hasSubscribed: false,
    }
    const sendWs = (msg: string) => {
      if (socket.writable && !socket.destroyed && !socket.writableEnded) {
        try {
          socket.write(frame(0x1, Buffer.from(msg, 'utf8')))
        } catch {
          wsClients.delete(client)
        }
      }
    }
    client.send = sendWs

    wsClients.add(client)
    socket.on('error', () => {
      wsClients.delete(client)
      socket.destroy()
    })
    socket.once('close', () => wsClients.delete(client))

    let buffer = Buffer.alloc(0)
    let fragments: Buffer[] = []
    let fragmentOpcode: number | null = null

    function handleRpc(reqObj: {
      id?: unknown
      method?: unknown
      params?: unknown
    }) {
      const method = typeof reqObj.method === 'string' ? reqObj.method : ''
      if (!method) return

      if (
        options.maxRpcRequests !== undefined &&
        rpcCalls.length >= options.maxRpcRequests
      ) {
        options.onClientError?.(new Error('Fixture request cap'))
        socket.destroy()
        return
      }

      recordCall(method)
      rpcCalls.push({
        method,
        params: reqObj.params,
        timestamp: Date.now(),
      })

      const rpcFault = faults.matchFault({
        path: '/websocket',
        method,
        topic: method,
      })
      if (rpcFault) {
        if (rpcFault.type === 'drop') {
          socket.destroy()
          return
        }
        if (rpcFault.type === 'stall') {
          return
        }
        if (rpcFault.type === 'malformed') {
          sendWs(
            typeof rpcFault.payload === 'string'
              ? rpcFault.payload
              : rpcFault.payload
                ? rpcFault.payload.toString('utf8')
                : '{malformed',
          )
          return
        }
        if (rpcFault.type === 'refuse') {
          sendWs(
            JSON.stringify({
              jsonrpc: '2.0',
              id: reqObj.id,
              error: {
                code: rpcFault.code ?? -32603,
                message: rpcFault.message ?? 'Injected fault',
              },
            }),
          )
          return
        }
        if (rpcFault.type === 'delay') {
          scheduleTimer(rpcFault.delayMs, () => {
            if (!socket.destroyed && socket.writable) {
              dispatchRpc(reqObj, method)
            }
          })
          return
        }
      }

      dispatchRpc(reqObj, method)
    }

    function dispatchRpc(
      reqObj: { id?: unknown; method?: unknown; params?: unknown },
      method: string,
    ) {
      const reply = (result: unknown) => {
        if (reqObj.id !== undefined) {
          sendWs(JSON.stringify({ jsonrpc: '2.0', id: reqObj.id, result }))
        }
      }
      const replyError = (code: number, message: string) => {
        if (reqObj.id !== undefined) {
          sendWs(
            JSON.stringify({
              jsonrpc: '2.0',
              id: reqObj.id,
              error: { code, message },
            }),
          )
        }
      }

      if (method === 'server.connection.identify') {
        reply({ connection_id: client.connectionId })
        return
      }

      if (method === 'server.info') {
        reply(serverInfoResult())
        return
      }

      if (method === 'printer.info') {
        if (!model.klippyConnected || model.klippyState === 'disconnected') {
          replyError(-32603, 'Klippy Host not connected')
          return
        }
        reply({
          state: model.klippyState,
          state_message:
            model.errorMessage ||
            (model.klippyState === 'ready'
              ? 'Printer is ready'
              : `Klippy ${model.klippyState}`),
          hostname: profile === 'u1' ? 'u1-mock' : 'sv06-mock',
        })
        return
      }

      if (method === 'server.webcams.list') {
        reply({ webcams })
        return
      }

      if (method === 'machine.update.status') {
        reply({ version_info: firmwareVersionInfo() })
        return
      }

      if (method === 'server.spoolman.get_spool_id') {
        reply({ spool_id: options.spoolId ?? null })
        return
      }

      if (method === 'server.files.list') {
        reply(fileListResult())
        return
      }

      if (method === 'server.files.metadata') {
        const filename =
          (reqObj.params as { filename?: unknown } | undefined)?.filename ?? ''
        if (typeof filename !== 'string') {
          replyError(-32602, 'Invalid filename')
          return
        }
        const meta = fileMetadataResult(filename)
        if (!meta) {
          replyError(-32602, 'Metadata not available')
          return
        }
        reply(meta)
        return
      }

      if (
        method === 'printer.restart' ||
        method === 'printer.firmware_restart'
      ) {
        triggerRestart()
        reply('ok')
        return
      }

      if (!isKlippyReady()) {
        replyError(-32603, 'Klippy Host is not ready')
        return
      }

      if (method === 'printer.objects.list') {
        reply({ objects: [...objectList] })
        return
      }

      if (
        method === 'printer.objects.query' ||
        method === 'printer.objects.subscribe'
      ) {
        const requested = (reqObj.params as { objects?: unknown } | undefined)
          ?.objects
        eventtime++
        const result = {
          eventtime,
          status: pickStatus(statusOf(model), requested),
        }
        if (method === 'printer.objects.subscribe') {
          client.subscribedObjects = requested
          client.hasSubscribed = true
        }
        reply(result)
        return
      }

      if (method === 'printer.gcode.script') {
        const script = (reqObj.params as { script?: unknown } | undefined)
          ?.script
        if (typeof script !== 'string') {
          replyError(-32602, 'Invalid script')
          return
        }
        executeGcode(script)
        reply('ok')
        return
      }

      if (method === 'printer.print.start') {
        const filename =
          (reqObj.params as { filename?: unknown } | undefined)?.filename ??
          model.filename
        if (typeof filename !== 'string') {
          replyError(-32602, 'Invalid filename')
          return
        }
        updateModel({
          state: 'printing',
          filename,
          progress: 0,
          errorMessage: '',
        })
        reply('ok')
        return
      }

      if (method === 'printer.print.pause') {
        updateModel({ state: 'paused' })
        reply('ok')
        return
      }

      if (method === 'printer.print.resume') {
        updateModel({ state: 'printing' })
        reply('ok')
        return
      }

      if (method === 'printer.print.cancel') {
        updateModel({ state: 'cancelled', progress: 0 })
        reply('ok')
        return
      }

      if (method === 'printer.emergency_stop') {
        updateModel({
          state: 'error',
          extruderTarget: 0,
          bedTarget: 0,
          fan: 0,
          errorMessage: 'Emergency stop',
        })
        reply('ok')
        return
      }

      replyError(-32601, 'Method not found')
    }

    socket.on('data', (chunk) => {
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
          const bigLen = buffer.readBigUInt64BE(2)
          if (bigLen > BigInt(16 * 1024 * 1024)) {
            socket.destroy()
            return
          }
          length = Number(bigLen)
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
          if (socket.writable && !socket.destroyed) {
            socket.write(frame(0x8, payload))
          }
          socket.end()
          return
        }
        if (opcode === 0x9) {
          if (socket.writable && !socket.destroyed) {
            socket.write(frame(0xa, payload))
          }
          continue
        }
        if (opcode === 0xa) {
          continue
        }

        if (opcode === 0x1 || opcode === 0x2) {
          fragmentOpcode = opcode
          fragments = [Buffer.from(payload)]
        } else if (opcode === 0x0 && fragmentOpcode !== null) {
          fragments.push(Buffer.from(payload))
        } else {
          continue
        }

        if (!fin) continue

        const fullOpcode = fragmentOpcode
        const fullPayload =
          fragments.length === 1 ? fragments[0]! : Buffer.concat(fragments)
        fragmentOpcode = null
        fragments = []

        if (fullOpcode !== 0x1) {
          options.onClientError?.(new Error('Unexpected binary frame'))
          socket.destroy()
          return
        }

        try {
          const parsed = JSON.parse(fullPayload.toString('utf8'))
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            handleRpc(
              parsed as { id?: unknown; method?: unknown; params?: unknown },
            )
          }
        } catch (err) {
          options.onClientError?.(
            err instanceof Error ? err : new Error('Invalid JSON'),
          )
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
    for (const timer of activeTimers) {
      clearTimeout(timer)
    }
    activeTimers.clear()
    wsClients.clear()
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
      model: () => ({
        ...model,
        extruders: { ...model.extruders },
      }),
      sockets: rawSockets,
      macroCalls,
      gcodeScripts,
      files: filesMap,
      setKlippyState,
      disconnectClients: () => {
        for (const client of [...wsClients]) {
          client.socket.destroy()
        }
      },
      completePrint: () => updateModel({ state: 'complete', progress: 1 }),
      failPrint: (message = 'Print failed') =>
        updateModel({ state: 'error', errorMessage: message }),
    },
    calls: callsFn as MoonrakerMockInstance['calls'],
    close,
  }
}
