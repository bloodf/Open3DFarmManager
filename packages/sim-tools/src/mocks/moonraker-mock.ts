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
  /** Moonraker components server.info lists; defaults to the mock's own. */
  components?: readonly string[] | undefined
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
  'exclude_object',
  'bed_mesh',
  'probe',
  'output_pin caselight',
  'fan_generic auxiliary',
  'heater_generic chamber',
  'led chamber',
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
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return null
  }
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
  const recordedCalls: {
    method: string
    params?: unknown
    timestamp: number
  }[] = []
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

  const position = [0, 0, 0, 0]
  const axisMinimum = [0, 0, 0, 0]
  const axisMaximum = [220, 220, 250, 0]
  const homed = new Set<string>()
  let absolute = true
  const pins = new Map<string, number>()
  const leds = new Map<string, number[]>()
  const excluded = new Set<string>()
  const printObjects = new Set<string>()
  let currentObject: string | null = null
  const meshProfiles = new Map<string, number[][]>()
  let mesh: number[][] = []
  let meshProfile = ''
  let probeResult: number | null = null
  const consoleStore: { message: string; time: number; type: string }[] = []
  const gcodeHelp = {
    G28: 'Home axes',
    G1: 'Move to a position',
    PROBE: 'Probe Z',
    BED_MESH_CALIBRATE: 'Calibrate bed mesh',
    BED_MESH_PROFILE: 'Manage mesh profiles',
    EXCLUDE_OBJECT: 'Exclude an object',
    SET_LED: 'Set LED color',
    SET_PIN: 'Set output pin',
    SET_HEATER_TEMPERATURE: 'Set heater target',
    SET_FAN_SPEED: 'Set fan speed',
    M118: 'Emit a console message',
  }
  function gcodeResponse(message: string, type = 'response') {
    consoleStore.push({ message, type, time: Date.now() / 1000 })
    if (consoleStore.length > 100) consoleStore.shift()
    if (type === 'command') return
    const notification = JSON.stringify({
      jsonrpc: '2.0',
      method: 'notify_gcode_response',
      params: [message],
    })
    for (const client of wsClients) client.send(notification)
  }

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
  let rpcRequestCount = 0
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

  const history = new Map<
    string,
    {
      job_id: string
      filename: string
      status: string
      start_time: number
      end_time: number
      print_duration: number
      total_duration: number
    }
  >()
  let nextJob = 0
  let printStarted = Date.now() / 1000
  const queue = new Map<
    string,
    { job_id: string; filename: string; time_added: number }
  >()
  let nextQueued = 0
  let queueState = 'ready'
  let power = 'off'
  let timelapseSettings: Record<string, unknown> = {
    enabled: false,
    mode: 'layermacro',
  }
  let lastFrame = 0
  const configFiles = new Map<string, StoredMoonrakerFile>()
  const directories = new Set<string>(['gcodes', 'config'])
  const fileRoot = (root: string) =>
    root === 'config' ? configFiles : filesMap
  const fileLocation = (value: unknown) => {
    const path = typeof value === 'string' ? safeFilePath(value) : null
    const slash = path?.indexOf('/') ?? -1
    const root = path?.slice(0, slash)
    if (!path || slash < 0 || (root !== 'gcodes' && root !== 'config')) {
      throw new Error('Invalid file path')
    }
    return { root, path: path.slice(slash + 1) }
  }
  const queueResult = () => ({
    queued_jobs: [...queue.values()],
    queue_state: queueState,
  })
  const powerDevice = (device: unknown = 'printer') => {
    if (device !== 'printer') throw new Error('Unknown power device')
    return { device, status: power }
  }
  function bulkPower(params: Record<string, unknown>, action?: 'on' | 'off') {
    const devices = Array.isArray(params.devices)
      ? params.devices
      : Object.keys(params)
    for (const device of devices) powerDevice(device)
    if (devices.length > 0 && action) power = action
    return Object.fromEntries(devices.map((device) => [device, power]))
  }
  const endpoints: Record<
    string,
    (params: Record<string, unknown>) => unknown
  > = {
    'printer.gcode.help': () => gcodeHelp,
    'server.gcode_store': ({ count }) => ({
      gcode_store: consoleStore.slice(
        Math.max(0, consoleStore.length - Number(count ?? 100)),
      ),
    }),
    'server.temperature_store': () => Object.fromEntries(temperatureStore),
    'server.files.roots': () =>
      ['gcodes', 'config'].map((name) => ({
        name,
        path: '/' + name,
        permissions: 'rw',
      })),
    'server.files.get_directory': ({ path = 'gcodes' }) => {
      const [root, ...parts] = String(path).split('/')
      const prefix = parts.length ? parts.join('/') + '/' : ''
      if (
        (root !== 'gcodes' && root !== 'config') ||
        !safeFilePath(String(path))
      )
        throw new Error('Invalid directory')
      const files = [...fileRoot(root).values()].filter((file) =>
        file.path.startsWith(prefix),
      )
      const children = new Set(
        [...directories, ...files.map((file) => root + '/' + file.path)]
          .filter((entry) => entry.startsWith(root + '/' + prefix))
          .map((entry) => entry.slice(root.length + 1 + prefix.length))
          .filter(
            (entry) =>
              entry.includes('/') ||
              directories.has(root + '/' + prefix + entry),
          )
          .map((entry) => entry.split('/')[0]),
      )
      return {
        dirs: [...children].map((dirname) => ({
          dirname,
          modified: 0,
          size: 0,
          permissions: 'rw',
        })),
        files: files
          .filter((file) => !file.path.slice(prefix.length).includes('/'))
          .map((file) => ({
            filename: file.path.slice(prefix.length),
            size: file.size,
            modified: file.modified,
            permissions: 'rw',
          })),
        root_info: { name: root, permissions: 'rw' },
      }
    },
    'server.files.post_directory': ({ path }) => {
      const item = fileLocation(path)
      directories.add(item.root + '/' + item.path)
      return { item, action: 'create_dir' }
    },
    'server.files.delete_directory': ({ path, force }) => {
      const item = fileLocation(path)
      const fullPath = item.root + '/' + item.path
      const prefix = item.path + '/'
      const files = fileRoot(item.root)
      const children = [...files.keys()].filter((name) =>
        name.startsWith(prefix),
      )
      const nested = [...directories].filter((name) =>
        name.startsWith(fullPath + '/'),
      )
      if (!directories.has(fullPath) && !children.length && !nested.length) {
        throw new Error('Directory not found')
      }
      if (
        (children.length || nested.length) &&
        force !== true &&
        force !== 'true'
      ) {
        throw new Error('Directory is not empty')
      }
      for (const name of children) files.delete(name)
      for (const name of nested) directories.delete(name)
      directories.delete(fullPath)
      return { item, action: 'delete_dir' }
    },
    'server.files.move': ({ source, dest }) => {
      const from = fileLocation(source)
      const to = fileLocation(dest)
      const file = fileRoot(from.root).get(from.path)
      if (!file) throw new Error('File not found')
      fileRoot(from.root).delete(from.path)
      fileRoot(to.root).set(to.path, { ...file, path: to.path })
      return { item: to, source_item: from, action: 'move_file' }
    },
    'server.files.delete_file': ({ path }) => {
      const item = fileLocation(path)
      if (!fileRoot(item.root).delete(item.path))
        throw new Error('File not found')
      return { item, action: 'delete_file' }
    },
    'server.history.list': ({
      limit = 50,
      start = 0,
      order = 'desc',
      since = 0,
      before = Infinity,
    }) => {
      const jobs = [...history.values()].filter(
        (job) =>
          job.start_time >= Number(since) && job.start_time <= Number(before),
      )
      if (order !== 'asc') jobs.reverse()
      return {
        count: jobs.length,
        jobs: jobs.slice(Number(start), Number(start) + Number(limit)),
      }
    },
    'server.history.get_job': ({ uid }) => {
      const job = history.get(String(uid))
      if (!job) throw new Error('Unknown history job')
      return { job }
    },
    'server.history.delete_job': ({ uid, all }) => {
      const deleted_jobs =
        all === true || all === 'true'
          ? [...history.keys()]
          : [String(uid)].filter((id) => history.has(id))
      for (const id of deleted_jobs) history.delete(id)
      return { deleted_jobs }
    },
    'server.history.totals': () => ({
      job_totals: {
        total_jobs: history.size,
        total_time: [...history.values()].reduce(
          (sum, job) => sum + job.total_duration,
          0,
        ),
        total_print_time: [...history.values()].reduce(
          (sum, job) => sum + job.print_duration,
          0,
        ),
      },
      auxiliary_totals: [],
    }),
    'server.job_queue.status': queueResult,
    'server.job_queue.post_job': ({ filenames, reset }) => {
      if (
        !Array.isArray(filenames) ||
        filenames.some((name) => typeof name !== 'string')
      )
        throw new Error('Invalid filenames')
      if (reset === true) queue.clear()
      for (const filename of filenames) {
        const job_id = String(++nextQueued)
        queue.set(job_id, { job_id, filename, time_added: Date.now() / 1000 })
      }
      return queueResult()
    },
    'server.job_queue.delete_job': ({ job_ids, all }) => {
      if (all === true || all === 'true') queue.clear()
      else
        for (const id of Array.isArray(job_ids)
          ? job_ids
          : String(job_ids ?? '').split(','))
          queue.delete(String(id))
      return queueResult()
    },
    'server.job_queue.jump': ({ job_id }) => {
      const job = queue.get(String(job_id))
      if (!job) throw new Error('Unknown queued job')
      const remaining = [...queue.values()].filter((entry) => entry !== job)
      queue.clear()
      for (const entry of [job, ...remaining]) queue.set(entry.job_id, entry)
      return queueResult()
    },
    'server.job_queue.pause': () => {
      queueState = 'paused'
      return queueResult()
    },
    'server.job_queue.start': () => {
      queueState = 'ready'
      return queueResult()
    },
    'machine.device_power.devices': () => ({
      devices: [
        { ...powerDevice(), type: 'gpio', locked_while_printing: false },
      ],
    }),
    'machine.device_power.get_device': ({ device }) => powerDevice(device),
    'machine.device_power.post_device': ({ device, action }) => {
      powerDevice(device)
      if (action === 'on' || action === 'off') power = action
      else if (action === 'toggle') power = power === 'on' ? 'off' : 'on'
      else throw new Error('Invalid power action')
      return powerDevice(device)
    },
    'machine.device_power.status': (params) => bulkPower(params),
    'machine.device_power.on': (params) => bulkPower(params, 'on'),
    'machine.device_power.off': (params) => bulkPower(params, 'off'),
    'machine.services.restart': ({ service }) => {
      if (typeof service !== 'string' || !service)
        throw new Error('Missing service')
      if (service === 'klipper') triggerRestart()
      return 'ok'
    },
    'machine.proc_stats': () => ({
      moonraker_stats: [
        { time: Date.now() / 1000, cpu_usage: 0, memory: 0, mem_units: 'kB' },
      ],
      system_cpu_usage: { cpu: 0 },
      system_memory: { total: 1024, available: 1024, used: 0 },
      websocket_connections: wsClients.size,
    }),
    'server.timelapse.get_settings': () => timelapseSettings,
    'server.timelapse.post_settings': (params) => {
      timelapseSettings = { ...timelapseSettings, ...params }
      return timelapseSettings
    },
    'server.timelapse.lastframe': () => ({ frame: lastFrame }),
    'server.timelapse.takeframe': () => ({ frame: ++lastFrame }),
    'server.timelapse.render': () => ({ status: 'success', frames: lastFrame }),
    'server.timelapse.saveframes': () => ({ frames: lastFrame }),
  }

  const httpEndpoints: Record<string, string> = {
    'GET /printer/gcode/help': 'printer.gcode.help',
    'GET /server/gcode_store': 'server.gcode_store',
    'GET /server/temperature_store': 'server.temperature_store',
    'GET /server/files/roots': 'server.files.roots',
    'GET /server/files/directory': 'server.files.get_directory',
    'POST /server/files/directory': 'server.files.post_directory',
    'DELETE /server/files/directory': 'server.files.delete_directory',
    'POST /server/files/move': 'server.files.move',
    'GET /server/history/list': 'server.history.list',
    'GET /server/history/job': 'server.history.get_job',
    'DELETE /server/history/job': 'server.history.delete_job',
    'GET /server/history/totals': 'server.history.totals',
    'GET /server/job_queue/status': 'server.job_queue.status',
    'POST /server/job_queue/job': 'server.job_queue.post_job',
    'DELETE /server/job_queue/job': 'server.job_queue.delete_job',
    'POST /server/job_queue/jump': 'server.job_queue.jump',
    'POST /server/job_queue/pause': 'server.job_queue.pause',
    'POST /server/job_queue/start': 'server.job_queue.start',
    'GET /machine/device_power/devices': 'machine.device_power.devices',
    'GET /machine/device_power/device': 'machine.device_power.get_device',
    'POST /machine/device_power/device': 'machine.device_power.post_device',
    'GET /machine/device_power/status': 'machine.device_power.status',
    'POST /machine/device_power/on': 'machine.device_power.on',
    'POST /machine/device_power/off': 'machine.device_power.off',
    'POST /machine/services/restart': 'machine.services.restart',
    'GET /machine/proc_stats': 'machine.proc_stats',
    'GET /server/timelapse/settings': 'server.timelapse.get_settings',
    'POST /server/timelapse/settings': 'server.timelapse.post_settings',
    'GET /server/timelapse/lastframe': 'server.timelapse.lastframe',
    'POST /server/timelapse/takeframe': 'server.timelapse.takeframe',
    'POST /server/timelapse/render': 'server.timelapse.render',
    'POST /server/timelapse/saveframes': 'server.timelapse.saveframes',
  }

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
        position,
        homed_axes: 'xyz'
          .split('')
          .filter((axis) => homed.has(axis))
          .join(''),
        axis_minimum: axisMinimum,
        axis_maximum: axisMaximum,
        max_velocity: 300,
        max_accel: 3000,
      },
      exclude_object: {
        objects: [...printObjects].map((name) => ({ name })),
        excluded_objects: [...excluded],
        current_object: currentObject,
      },
      bed_mesh: {
        profile_name: meshProfile,
        mesh_min: [0, 0],
        mesh_max: [220, 220],
        probed_matrix: mesh,
        mesh_matrix: mesh,
        profiles: Object.fromEntries(
          [...meshProfiles].map(([name, points]) => [name, { points }]),
        ),
      },
      probe: { last_z_result: probeResult },
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
      } else if (obj.startsWith('output_pin ')) {
        const name = obj.slice('output_pin '.length)
        all[obj] = {
          value: name === 'caselight' ? m.caselight : (pins.get(name) ?? 0),
        }
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
          color_data: [
            leds.get(obj.slice(obj.indexOf(' ') + 1)) ?? [
              m.caselight,
              m.caselight,
              m.caselight,
              0,
            ],
          ],
        }
      }
    }

    return all
  }

  const temperatureStore = new Map<
    string,
    {
      temperatures: number[]
      targets: number[]
      powers: number[]
    }
  >()

  function sampleTemperature(current: Record<string, object>) {
    for (const [name, status] of Object.entries(current)) {
      if (
        !('temperature' in status) ||
        typeof status.temperature !== 'number' ||
        !('target' in status) ||
        typeof status.target !== 'number'
      )
        continue
      const series = temperatureStore.get(name) ?? {
        temperatures: [],
        targets: [],
        powers: [],
      }
      series.temperatures.push(status.temperature)
      series.targets.push(status.target)
      series.powers.push(
        'power' in status && typeof status.power === 'number'
          ? status.power
          : 0,
      )
      if (series.temperatures.length > 1200) {
        series.temperatures.shift()
        series.targets.shift()
        series.powers.shift()
      }
      temperatureStore.set(name, series)
    }
  }

  sampleTemperature(statusOf(model))

  function broadcastStatus() {
    eventtime++
    const current = statusOf(model)
    sampleTemperature(current)
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
    if (
      patch.state === 'printing' &&
      model.state !== 'printing' &&
      model.state !== 'paused'
    ) {
      printStarted = Date.now() / 1000
      excluded.clear()
      printObjects.clear()
      currentObject = null
    }
    if (
      (model.state === 'printing' || model.state === 'paused') &&
      (patch.state === 'complete' ||
        patch.state === 'cancelled' ||
        patch.state === 'error')
    ) {
      const job_id = (++nextJob).toString(16).padStart(6, '0')
      history.set(job_id, {
        job_id,
        filename: model.filename,
        status: patch.state === 'complete' ? 'completed' : patch.state,
        start_time: printStarted,
        end_time: Date.now() / 1000,
        print_duration: patch.printDuration ?? model.printDuration,
        total_duration: patch.totalDuration ?? model.totalDuration,
      })
    }
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

    gcodeResponse(script, 'command')
    const patch: Partial<MoonrakerModel> = {}
    let touchedExtruder = false
    const nextExtruders = { ...model.extruders }

    for (const rawLine of script.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line) continue
      const upper = line.toUpperCase()
      const command = upper.split(/\s+/, 1)[0]
      const args = Object.fromEntries(
        [...line.matchAll(/\b(\w+)=([^\s;]+)/g)].map((match) => [
          match[1]!.toUpperCase(),
          match[2]!,
        ]),
      )
      switch (command) {
        case 'G28': {
          const axes = upper.slice(3).match(/[XYZ]/g) ?? ['X', 'Y', 'Z']
          for (const axis of axes) {
            homed.add(axis.toLowerCase())
            position['XYZ'.indexOf(axis)] = 0
          }
          continue
        }
        case 'G90':
        case 'G91':
          absolute = command === 'G90'
          continue
        case 'G0':
        case 'G1': {
          const next = [...position]
          for (const match of upper
            .slice(command.length)
            .matchAll(/([XYZE])\s*(-?\d+(?:\.\d+)?)/g)) {
            const axis = 'XYZE'.indexOf(match[1]!)
            next[axis] = Number(match[2]) + (absolute ? 0 : position[axis]!)
          }
          if (
            next
              .slice(0, 3)
              .some(
                (value, axis) =>
                  value < axisMinimum[axis]! || value > axisMaximum[axis]!,
              )
          ) {
            gcodeResponse('!! Move out of range')
          } else {
            position.splice(0, position.length, ...next)
          }
          continue
        }
        case 'PROBE':
          probeResult = 0.125
          gcodeResponse('probe at 0.000,0.000 is z=0.125000')
          continue
        case 'BED_MESH_CALIBRATE':
          mesh = [
            [0, 0.125],
            [0.125, 0],
          ]
          meshProfile = args.PROFILE ?? 'default'
          meshProfiles.set(meshProfile, mesh)
          continue
        case 'BED_MESH_CLEAR':
          mesh = []
          meshProfile = ''
          continue
        case 'BED_MESH_PROFILE':
          if (args.SAVE && mesh.length) meshProfiles.set(args.SAVE, mesh)
          if (args.LOAD) {
            const saved = meshProfiles.get(args.LOAD)
            if (saved) {
              mesh = saved
              meshProfile = args.LOAD
            } else gcodeResponse('!! Unknown mesh profile')
          }
          if (args.REMOVE) meshProfiles.delete(args.REMOVE)
          continue
        case 'EXCLUDE_OBJECT_DEFINE':
          if (args.RESET === '1') {
            printObjects.clear()
            excluded.clear()
            currentObject = null
          }
          if (args.NAME) printObjects.add(args.NAME)
          continue
        case 'EXCLUDE_OBJECT_START':
          currentObject = args.NAME ?? null
          continue
        case 'EXCLUDE_OBJECT_END':
          currentObject = null
          continue
        case 'EXCLUDE_OBJECT':
          if (args.RESET === '1') excluded.clear()
          else if (args.NAME ?? currentObject)
            excluded.add((args.NAME ?? currentObject)!)
          continue
        case 'M118':
          gcodeResponse(line.slice(4).trim())
          continue
      }

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
        if (pinMatch && valMatch) {
          const name = pinMatch[1]!
          if (name.toLowerCase() === 'caselight')
            patch.caselight = Number(valMatch[1])
          else pins.set(name, Number(valMatch[1]))
        }
        continue
      }

      if (upper.startsWith('SET_LED ')) {
        const whiteMatch = /WHITE=(\d+(?:\.\d+)?)/i.exec(line)
        if (whiteMatch) patch.caselight = Number(whiteMatch[1])
        if (args.LED) {
          const previous = leds.get(args.LED) ?? [0, 0, 0, 0]
          leds.set(
            args.LED,
            ['RED', 'GREEN', 'BLUE', 'WHITE'].map((channel, index) =>
              args[channel] === undefined
                ? previous[index]!
                : Number(args[channel]),
            ),
          )
        }
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
    } else {
      broadcastStatus()
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
      components: options.components ?? [
        'file_manager',
        'history',
        'job_queue',
        'spoolman',
        'update_manager',
        'webcam',
        ...(authConfig ? ['authorization'] : []),
      ],
      websockets: wsClients.size,
      websockets_count: wsClients.size,
    }
  }

  function fileListResult(root = 'gcodes') {
    if (root !== 'gcodes' && root !== 'config') return []
    return [...fileRoot(root).values()].map((f) => ({
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
    const call = `HTTP ${method} ${path}`
    recordCall(call)
    if (method !== 'GET' && method !== 'HEAD') {
      recordedCalls.push({
        method: call,
        params: Object.fromEntries(url.searchParams),
        timestamp: Date.now(),
      })
    }

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

    const endpoint = httpEndpoints[method + ' ' + path]
    if (endpoint) {
      try {
        const params = {
          ...Object.fromEntries(url.searchParams),
          ...(body.length ? JSON.parse(body.toString('utf8')) : {}),
        }
        sendJson(res, 200, { result: endpoints[endpoint]!(params) })
      } catch (error) {
        sendJson(res, 400, {
          error: { code: 400, message: (error as Error).message },
        })
      }
      return
    }

    // Files
    if (path === '/server/files/list' && method === 'GET') {
      sendJson(res, 200, {
        result: fileListResult(url.searchParams.get('root') ?? undefined),
      })
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
        if (parsed.root !== 'gcodes' && parsed.root !== 'config') {
          sendJson(res, 400, { error: { code: 400, message: 'Invalid root' } })
          return
        }
        fileRoot(parsed.root).set(safe, entry)
        if (parsed.root === 'gcodes' && parsed.startPrint && isKlippyReady()) {
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

    const download = /^\/server\/files\/(gcodes|config)\/(.+)$/.exec(path)
    if (download) {
      const root = download[1]!
      const files = fileRoot(root)
      const rel = safeFilePath(download[2]!)
      if (!rel) {
        sendJson(res, 400, { error: { code: 400, message: 'Invalid path' } })
        return
      }
      if (method === 'DELETE') {
        const existed = files.delete(rel)
        if (!existed) {
          sendJson(res, 404, { error: { code: 404, message: 'Not found' } })
          return
        }
        sendJson(res, 200, {
          result: {
            item: { path: rel, root },
            action: 'delete_file',
          },
        })
        return
      }
      if (method === 'GET') {
        const direct = files.get(rel)
        if (direct) {
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': direct.content.length,
          })
          res.end(direct.content)
          return
        }
        for (const file of files.values()) {
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
        rpcRequestCount >= options.maxRpcRequests
      ) {
        options.onClientError?.(new Error('Fixture request cap'))
        socket.destroy()
        return
      }

      rpcRequestCount++
      recordCall(method)
      recordedCalls.push({
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

      if (Object.hasOwn(endpoints, method)) {
        try {
          reply(
            endpoints[method]!(
              (reqObj.params ?? {}) as Record<string, unknown>,
            ),
          )
        } catch (error) {
          replyError(-32602, (error as Error).message)
        }
        return
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
        reply(
          fileListResult(
            (reqObj.params as { root?: string } | undefined)?.root,
          ),
        )
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
    get: () => recordedCalls,
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
