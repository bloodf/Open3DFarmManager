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

export type MoonrakerFileRoot = 'gcodes' | 'config' | 'timelapse'

export interface MoonrakerHistoryJobSeed {
  job_id?: string | undefined
  filename: string
  status?: string | undefined
  start_time?: number | undefined
  end_time?: number | undefined
  print_duration?: number | undefined
  total_duration?: number | undefined
  filament_used?: number | undefined
  exists?: boolean | undefined
  metadata?: Record<string, unknown> | undefined
}

export interface MoonrakerPowerDeviceSeed {
  device: string
  status?: 'on' | 'off' | 'init' | 'error' | undefined
  locked_while_printing?: boolean | undefined
  type?: string | undefined
}

export interface MoonrakerExcludeObjectSeed {
  name: string
  center?: readonly [number, number] | undefined
  polygon?: readonly (readonly [number, number])[] | undefined
}

export interface MoonrakerBedMeshProfileSeed {
  name: string
  points: number[][]
  min_x?: number | undefined
  max_x?: number | undefined
  min_y?: number | undefined
  max_y?: number | undefined
  x_count?: number | undefined
  y_count?: number | undefined
  mesh_x_pps?: number | undefined
  mesh_y_pps?: number | undefined
  algo?: string | undefined
  tension?: number | undefined
}

export interface MoonrakerDirectorySeed {
  root?: MoonrakerFileRoot | undefined
  path: string
}

export interface MoonrakerTimelapseOptions {
  enabled?: boolean | undefined
  files?: readonly MoonrakerFileEntry[] | undefined
  settings?: Record<string, unknown> | undefined
  framecount?: number | undefined
  lastframefile?: string | null | undefined
}

export interface MoonrakerMockOptions {
  profile?: MoonrakerProfile | undefined
  /** Advance active print duration on the same simulated clock as eventtime. */
  clockedPrintDuration?: boolean | undefined
  initial?: Partial<MoonrakerModel> | undefined
  scenario?: ScenarioStep<MoonrakerModel>[] | undefined
  objects?: readonly string[] | undefined
  macros?: readonly string[] | undefined
  webcams?: readonly MoonrakerWebcamEntry[] | undefined
  files?: readonly MoonrakerFileEntry[] | undefined
  directories?: readonly MoonrakerDirectorySeed[] | undefined
  configFiles?: readonly MoonrakerFileEntry[] | undefined
  history?: readonly MoonrakerHistoryJobSeed[] | undefined
  powerDevices?: readonly MoonrakerPowerDeviceSeed[] | undefined
  excludeObjects?: readonly MoonrakerExcludeObjectSeed[] | undefined
  bedMeshProfiles?: readonly MoonrakerBedMeshProfileSeed[] | undefined
  activeMesh?: string | null | undefined
  timelapse?: false | MoonrakerTimelapseOptions | undefined
  /** Rendered videos seeded into the `timelapse` file root. */
  timelapseFiles?: readonly MoonrakerFileEntry[] | undefined
  /** Components server.info lists; defaults to the mock's own list. */
  components?: readonly string[] | undefined
  /** Axes homed at start, such as `xyz` or `` for none. Defaults to `xyz`. */
  homedAxes?: string | undefined
  gcodeHelp?: Record<string, string> | undefined
  temperatureStoreLength?: number | undefined
  auth?: MoonrakerAuthConfig | undefined
  firmware?:
    | {
        klipper?: MoonrakerFirmwareComponent | undefined
        moonraker?: MoonrakerFirmwareComponent | undefined
        system?: MoonrakerFirmwareComponent | undefined
      }
    | undefined
  /** Seeds `configfile.settings`; the object is absent when not given. */
  configfileSettings?: Record<string, unknown> | undefined
  /**
   * Seeds `configfile.config`, the raw sections the Connector reads macro
   * parameters from (`gcode_macro NAME` -> `{ gcode }`).
   */
  configfileConfig?: Record<string, Record<string, unknown>> | undefined
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
  root: MoonrakerFileRoot
  size: number
  modified: number
  estimatedTime?: number | undefined
  content: Buffer
  thumbnails: Map<string, MoonrakerThumbnailEntry>
}

export interface MoonrakerQueuedJob {
  filename: string
  job_id: string
  time_added: number
  time_in_queue: number
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
    directories: Set<string>
    historyJobs: MoonrakerHistoryJobSeed[]
    jobQueue: { state: string; jobs: MoonrakerQueuedJob[] }
    powerDevices: Map<
      string,
      {
        device: string
        status: 'on' | 'off' | 'init' | 'error'
        locked_while_printing: boolean
        type: string
      }
    >
    setKlippyState: (
      state: KlippyState,
      opts?: { connected?: boolean | undefined; message?: string | undefined },
    ) => void
    disconnectClients: () => void
    completePrint: () => void
    failPrint: (message?: string) => void
    broadcastGcodeResponse: (message: string) => void
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
  if (options.configfileSettings || options.configfileConfig)
    objectSet.add('configfile')
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
  const controllerFans = new Map<string, number>()
  const genericHeaters = new Map<string, MoonrakerExtruderState>()
  const outputPins = new Map<string, number>()
  const ledColors = new Map<string, [number, number, number, number]>()
  for (const obj of objectList) {
    if (obj.startsWith('fan_generic ')) {
      genericFans.set(obj.slice('fan_generic '.length), 0)
    } else if (obj.startsWith('controller_fan ')) {
      controllerFans.set(obj.slice('controller_fan '.length), 0)
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
    } else if (obj.startsWith('output_pin ')) {
      const name = obj.slice('output_pin '.length)
      outputPins.set(
        name,
        name === 'caselight' ? (options.initial?.caselight ?? 0) : 0,
      )
    } else if (
      obj.startsWith('led ') ||
      obj.startsWith('neopixel ') ||
      obj.startsWith('dotstar ') ||
      obj.startsWith('pca9533 ') ||
      obj.startsWith('pca9632 ')
    ) {
      const name = obj.slice(obj.indexOf(' ') + 1)
      ledColors.set(name, [0, 0, 0, 0])
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

  function storeFileEntry(
    entry: MoonrakerFileEntry,
    root: MoonrakerFileRoot,
    map: Map<string, StoredMoonrakerFile>,
  ) {
    const buf =
      entry.content === undefined
        ? Buffer.from(root === 'gcodes' ? '; mock gcode\n' : '# mock config\n')
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
    const key = `${root}:${entry.path}`
    map.set(key, {
      path: entry.path,
      root,
      size: entry.size ?? buf.length,
      modified: entry.modified ?? Math.floor(Date.now() / 1000),
      estimatedTime: entry.estimatedTime,
      content: buf,
      thumbnails: thumbs,
    })
  }

  const filesMap = new Map<string, StoredMoonrakerFile>()
  for (const entry of options.files ?? []) {
    storeFileEntry(entry, 'gcodes', filesMap)
  }
  for (const entry of options.configFiles ?? []) {
    storeFileEntry(entry, 'config', filesMap)
  }

  const directories = new Set<string>()
  // Stats for directories made via `server.files.post_directory`; others keep
  // the default live mtime and 4096-byte size in listings.
  const directoryStats = new Map<string, { modified: number; size: number }>()
  for (const dir of options.directories ?? []) {
    const root = dir.root ?? 'gcodes'
    const safe = safeFilePath(dir.path)
    if (safe) directories.add(`${root}:${safe}`)
  }

  const historyJobs: MoonrakerHistoryJobSeed[] = (options.history ?? []).map(
    (job, index) => ({
      job_id: job.job_id ?? String(index + 1).padStart(6, '0'),
      filename: job.filename,
      status: job.status ?? 'completed',
      start_time: job.start_time ?? Math.floor(Date.now() / 1000) - 3600,
      end_time: job.end_time ?? Math.floor(Date.now() / 1000) - 1800,
      print_duration: job.print_duration ?? 600,
      total_duration: job.total_duration ?? 700,
      filament_used: job.filament_used ?? 100,
      exists: job.exists ?? true,
      metadata: job.metadata ?? {},
    }),
  )

  const jobQueue: { state: string; jobs: MoonrakerQueuedJob[] } = {
    state: 'ready',
    jobs: [],
  }
  let nextJobId = 1

  const powerDevices = new Map<
    string,
    {
      device: string
      status: 'on' | 'off' | 'init' | 'error'
      locked_while_printing: boolean
      type: string
    }
  >()
  for (const device of options.powerDevices ?? [
    {
      device: 'printer',
      status: 'on' as const,
      locked_while_printing: true,
      type: 'gpio',
    },
  ]) {
    powerDevices.set(device.device, {
      device: device.device,
      status: device.status ?? 'off',
      locked_while_printing: device.locked_while_printing ?? false,
      type: device.type ?? 'gpio',
    })
  }

  type ExcludeObjectState = {
    name: string
    center: [number, number]
    polygon: [number, number][]
    excluded: boolean
  }
  const excludeObjects: ExcludeObjectState[] = (
    options.excludeObjects ?? [
      {
        name: 'object_0',
        center: [50, 50] as const,
        polygon: [
          [40, 40],
          [60, 40],
          [60, 60],
          [40, 60],
        ] as const,
      },
    ]
  ).map((obj) => ({
    name: obj.name,
    center: [...(obj.center ?? [0, 0])] as [number, number],
    polygon: (obj.polygon ?? []).map((p) => [...p] as [number, number]),
    excluded: false,
  }))
  let currentExcludeObject: string | null = excludeObjects[0]?.name ?? null

  type BedMeshProfile = MoonrakerBedMeshProfileSeed
  const bedMeshProfiles = new Map<string, BedMeshProfile>()
  const defaultMesh: BedMeshProfile = {
    name: 'default',
    points: [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ],
    min_x: 0,
    max_x: 220,
    min_y: 0,
    max_y: 220,
    x_count: 3,
    y_count: 3,
    mesh_x_pps: 2,
    mesh_y_pps: 2,
    algo: 'bicubic',
    tension: 0.2,
  }
  for (const profile of options.bedMeshProfiles ?? [defaultMesh]) {
    bedMeshProfiles.set(profile.name, {
      ...profile,
      points: profile.points.map((row) => [...row]),
    })
  }
  let activeMeshName: string | null =
    options.activeMesh === undefined
      ? (bedMeshProfiles.keys().next().value ?? null)
      : options.activeMesh

  let toolheadPosition: [number, number, number, number] = [0, 0, 0, 0]
  let homedAxes = options.homedAxes ?? 'xyz'
  let absoluteMoves = true
  const axisMinimum: [number, number, number] = [0, 0, 0]
  const axisMaximum: [number, number, number] = [220, 220, 250]
  let probeZ = 0

  const tempStoreLength = Math.max(1, options.temperatureStoreLength ?? 5)
  const temperatureStore: Record<
    string,
    {
      temperatures: number[]
      targets?: number[]
      powers?: number[]
      speeds?: number[]
    }
  > = {
    extruder: {
      temperatures: Array.from(
        { length: tempStoreLength },
        () => model.extruder,
      ),
      targets: Array.from(
        { length: tempStoreLength },
        () => model.extruderTarget,
      ),
      powers: Array.from({ length: tempStoreLength }, () =>
        model.extruderTarget > 0 ? 0.5 : 0,
      ),
    },
    heater_bed: {
      temperatures: Array.from({ length: tempStoreLength }, () => model.bed),
      targets: Array.from({ length: tempStoreLength }, () => model.bedTarget),
      powers: Array.from({ length: tempStoreLength }, () =>
        model.bedTarget > 0 ? 0.5 : 0,
      ),
    },
  }

  const timelapseEnabled = options.timelapse !== false
  const timelapseSettings: Record<string, unknown> = {
    enabled: true,
    mode: 'layermacro',
    camera: 'default',
    ...(typeof options.timelapse === 'object'
      ? options.timelapse.settings
      : {}),
  }
  let timelapseFramecount =
    typeof options.timelapse === 'object'
      ? (options.timelapse.framecount ?? 0)
      : 0
  let timelapseLastFrame: string | null =
    typeof options.timelapse === 'object'
      ? (options.timelapse.lastframefile ?? null)
      : null
  if (typeof options.timelapse === 'object') {
    for (const entry of options.timelapse.files ?? []) {
      storeFileEntry(entry, 'timelapse', filesMap)
    }
  }
  for (const entry of options.timelapseFiles ?? []) {
    storeFileEntry(entry, 'timelapse', filesMap)
  }
  // The Connector's timelapse control speaks the `server.timelapse.*`
  // methods; they share the plugin state above.
  function serverTimelapse(
    method: string,
    params: Record<string, unknown>,
  ): { result: unknown } | null {
    switch (method) {
      case 'server.timelapse.get_settings':
        return { result: { ...timelapseSettings } }
      case 'server.timelapse.post_settings':
        Object.assign(timelapseSettings, params)
        return { result: { ...timelapseSettings } }
      case 'server.timelapse.lastframe':
        return { result: { frame: timelapseFramecount } }
      case 'server.timelapse.takeframe':
        timelapseFramecount += 1
        return { result: { frame: timelapseFramecount } }
      case 'server.timelapse.render':
        return { result: { status: 'success', frames: timelapseFramecount } }
      case 'server.timelapse.saveframes':
        return { result: { frames: timelapseFramecount } }
      default:
        return null
    }
  }
  const serverTimelapseHttp: Record<string, string> = {
    'GET /server/timelapse/settings': 'server.timelapse.get_settings',
    'POST /server/timelapse/settings': 'server.timelapse.post_settings',
    'GET /server/timelapse/lastframe': 'server.timelapse.lastframe',
    'POST /server/timelapse/takeframe': 'server.timelapse.takeframe',
    'POST /server/timelapse/render': 'server.timelapse.render',
    'POST /server/timelapse/saveframes': 'server.timelapse.saveframes',
  }

  const gcodeHelp: Record<string, string> = {
    G28: 'Home axes',
    M104: 'Set extruder temperature',
    M140: 'Set bed temperature',
    EXCLUDE_OBJECT: 'Exclude an object by name',
    BED_MESH_PROFILE: 'Load or save a bed mesh profile',
    G1: 'Move to a position',
    PROBE: 'Probe Z',
    BED_MESH_CALIBRATE: 'Calibrate bed mesh',
    SET_LED: 'Set LED color',
    SET_PIN: 'Set output pin',
    SET_HEATER_TEMPERATURE: 'Set heater target',
    SET_FAN_SPEED: 'Set fan speed',
    M118: 'Emit a console message',
    ...(options.gcodeHelp ?? {}),
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
  let printSourceStartedAt = eventtime
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
        total_duration:
          options.clockedPrintDuration &&
          (m.state === 'printing' || m.state === 'paused')
            ? eventtime - printSourceStartedAt
            : m.totalDuration,
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
        position: [...toolheadPosition],
        homed_axes: homedAxes,
        axis_minimum: [...axisMinimum],
        axis_maximum: [...axisMaximum],
        max_velocity: 300,
        max_accel: 3000,
        estimated_print_time: m.printDuration,
        print_time: m.printDuration,
      },
      exclude_object: {
        objects: excludeObjects.map(({ name, center, polygon }) => ({
          name,
          center,
          polygon,
        })),
        excluded_objects: excludeObjects
          .filter((o) => o.excluded)
          .map((o) => o.name),
        current_object: currentExcludeObject,
      },
      bed_mesh: (() => {
        const profile =
          (activeMeshName && bedMeshProfiles.get(activeMeshName)) || defaultMesh
        return {
          profile_name: activeMeshName ?? '',
          mesh_min: [profile.min_x ?? 0, profile.min_y ?? 0],
          mesh_max: [profile.max_x ?? 220, profile.max_y ?? 220],
          probed_matrix: profile.points,
          mesh_matrix: profile.points,
          profiles: Object.fromEntries(
            [...bedMeshProfiles.entries()].map(([name, p]) => [
              name,
              {
                points: p.points,
                mesh_params: {
                  min_x: p.min_x ?? 0,
                  max_x: p.max_x ?? 220,
                  min_y: p.min_y ?? 0,
                  max_y: p.max_y ?? 220,
                  x_count: p.x_count ?? p.points[0]?.length ?? 3,
                  y_count: p.y_count ?? p.points.length,
                  mesh_x_pps: p.mesh_x_pps ?? 2,
                  mesh_y_pps: p.mesh_y_pps ?? 2,
                  algo: p.algo ?? 'bicubic',
                  tension: p.tension ?? 0.2,
                },
              },
            ]),
          ),
        }
      })(),
      probe: {
        last_query: true,
        last_z_result: probeZ,
      },
      save_variables: {
        variables:
          m.activeTool !== undefined ? { active_tool: m.activeTool } : {},
      },
      extruder: {
        temperature: m.extruders.extruder?.temperature ?? m.extruder,
        target: m.extruders.extruder?.target ?? m.extruderTarget,
        power: (m.extruders.extruder?.target ?? m.extruderTarget) > 0 ? 0.5 : 0,
        // Klipper reports it from min_extrude_temp (170 °C by default).
        can_extrude: (m.extruders.extruder?.temperature ?? m.extruder) >= 170,
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
    if (options.configfileSettings || options.configfileConfig)
      all.configfile = {
        ...(options.configfileSettings
          ? { settings: structuredClone(options.configfileSettings) }
          : {}),
        ...(options.configfileConfig
          ? { config: structuredClone(options.configfileConfig) }
          : {}),
        save_config_pending: false,
      }

    for (const obj of objectList) {
      if (obj in all) continue
      if (/^extruder[1-9]\d*$/.test(obj)) {
        const ext = m.extruders[obj] ?? { temperature: 20, target: 0 }
        all[obj] = {
          temperature: ext.temperature,
          target: ext.target,
          power: ext.target > 0 ? 0.5 : 0,
          can_extrude: ext.temperature >= 170,
        }
      } else if (obj.startsWith('output_pin ')) {
        const name = obj.slice('output_pin '.length)
        all[obj] = {
          value:
            name === 'caselight' ? m.caselight : (outputPins.get(name) ?? 0),
        }
      } else if (obj.startsWith('fan_generic ')) {
        const name = obj.slice('fan_generic '.length)
        all[obj] = { speed: genericFans.get(name) ?? 0 }
      } else if (obj.startsWith('controller_fan ')) {
        const name = obj.slice('controller_fan '.length)
        all[obj] = { speed: controllerFans.get(name) ?? 0 }
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
        const name = obj.slice(obj.indexOf(' ') + 1)
        const color = ledColors.get(name) ?? [
          m.caselight,
          m.caselight,
          m.caselight,
          0,
        ]
        all[obj] = { color_data: [color] }
      }
    }

    return all
  }

  /** Rolls each heater's temperature window forward by one sample. */
  function sampleTemperatures(current: Record<string, object>) {
    for (const [name, series] of Object.entries(temperatureStore)) {
      const status = current[name] as
        { temperature?: unknown; target?: unknown; power?: unknown } | undefined
      if (typeof status?.temperature !== 'number') continue
      const roll = (values: number[], value: number) => [
        ...values.slice(1),
        value,
      ]
      temperatureStore[name] = {
        ...series,
        temperatures: roll(series.temperatures, status.temperature),
        ...(series.targets && {
          targets: roll(
            series.targets,
            typeof status.target === 'number' ? status.target : 0,
          ),
        }),
        ...(series.powers && {
          powers: roll(
            series.powers,
            typeof status.power === 'number' ? status.power : 0,
          ),
        }),
      }
    }
  }

  function broadcastStatus() {
    eventtime++
    const current = statusOf(model)
    sampleTemperatures(current)
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

  function broadcastGcodeResponse(message: string) {
    const msg = JSON.stringify({
      jsonrpc: '2.0',
      method: 'notify_gcode_response',
      params: [message],
    })
    for (const client of wsClients) {
      client.send(msg)
    }
  }

  function updateModel(patch: Partial<MoonrakerModel>) {
    recordPrintTransition(patch)
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
    let statusDirty = false
    const nextExtruders = { ...model.extruders }
    const responses: string[] = []

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
          const name = fanMatch[1]!
          const speed = Math.min(1, Math.max(0, Number(speedMatch[1])))
          if (controllerFans.has(name)) controllerFans.set(name, speed)
          else genericFans.set(name, speed)
          statusDirty = true
        }
        continue
      }

      if (upper.startsWith('SET_PIN ')) {
        const pinMatch = /PIN=([A-Za-z0-9_]+)/i.exec(line)
        const valMatch = /VALUE=(\d+(?:\.\d+)?)/i.exec(line)
        if (pinMatch && valMatch) {
          const name = pinMatch[1]!
          const value = Number(valMatch[1])
          outputPins.set(name, value)
          if (name.toLowerCase() === 'caselight') patch.caselight = value
          statusDirty = true
        }
        continue
      }

      if (upper.startsWith('SET_LED ')) {
        const ledMatch = /LED=([A-Za-z0-9_]+)/i.exec(line)
        const r = Number(/RED=(\d+(?:\.\d+)?)/i.exec(line)?.[1] ?? 0)
        const g = Number(/GREEN=(\d+(?:\.\d+)?)/i.exec(line)?.[1] ?? 0)
        const b = Number(/BLUE=(\d+(?:\.\d+)?)/i.exec(line)?.[1] ?? 0)
        const w = Number(/WHITE=(\d+(?:\.\d+)?)/i.exec(line)?.[1] ?? 0)
        if (ledMatch) {
          ledColors.set(ledMatch[1]!, [r, g, b, w])
          statusDirty = true
        }
        if (/WHITE=(\d+(?:\.\d+)?)/i.test(line) && !ledMatch) {
          patch.caselight = w
        }
        continue
      }

      if (upper === 'G90' || upper === 'G91') {
        absoluteMoves = upper === 'G90'
        continue
      }

      const moveMatch = /^G[01](?:\s|$)/.exec(upper)
      if (moveMatch) {
        const next: [number, number, number, number] = [...toolheadPosition]
        for (const match of upper
          .slice(2)
          .matchAll(/([XYZE])\s*(-?\d+(?:\.\d+)?)/g)) {
          const axis = 'XYZE'.indexOf(match[1]!)
          next[axis] =
            Number(match[2]) + (absoluteMoves ? 0 : toolheadPosition[axis]!)
        }
        const outOfRange = next
          .slice(0, 3)
          .some(
            (value, axis) =>
              value < axisMinimum[axis]! || value > axisMaximum[axis]!,
          )
        if (outOfRange) responses.push('!! Move out of range')
        else toolheadPosition = next
        statusDirty = true
        continue
      }

      if (upper === 'M84' || upper === 'M18') {
        homedAxes = ''
        statusDirty = true
        continue
      }

      if (upper === 'G28' || upper.startsWith('G28 ')) {
        const axes = upper.slice(3).replace(/\s+/g, '')
        if (!axes) homedAxes = 'xyz'
        else {
          const parts: string[] = []
          if (axes.includes('X')) parts.push('x')
          if (axes.includes('Y')) parts.push('y')
          if (axes.includes('Z')) parts.push('z')
          homedAxes = parts.join('') || 'xyz'
        }
        if (homedAxes.includes('x')) toolheadPosition[0] = axisMinimum[0]
        if (homedAxes.includes('y')) toolheadPosition[1] = axisMinimum[1]
        if (homedAxes.includes('z')) toolheadPosition[2] = axisMinimum[2]
        responses.push('// Homed ' + (homedAxes || 'xyz'))
        statusDirty = true
        continue
      }

      const defineMatch =
        /^EXCLUDE_OBJECT_(DEFINE|START|END)(?:\s+NAME=([A-Za-z0-9_-]+))?/i.exec(
          line,
        )
      if (defineMatch) {
        const kind = defineMatch[1]!.toUpperCase()
        const name = defineMatch[2]
        if (kind === 'DEFINE' && name) {
          if (!excludeObjects.some((o) => o.name === name)) {
            excludeObjects.push({
              name,
              center: [0, 0],
              polygon: [],
              excluded: false,
            })
          }
        } else if (kind === 'START') {
          currentExcludeObject = name ?? null
        } else if (kind === 'END') {
          currentExcludeObject = null
        }
        statusDirty = true
        continue
      }

      const excludeMatch = /^EXCLUDE_OBJECT(?:\s+NAME=([A-Za-z0-9_-]+))?/i.exec(
        line,
      )
      if (excludeMatch) {
        const name = excludeMatch[1]
        if (name) {
          const target = excludeObjects.find((o) => o.name === name)
          if (target) {
            target.excluded = true
            responses.push(`// Excluded object ${name}`)
            statusDirty = true
          } else {
            responses.push(`!! Unknown exclude object ${name}`)
          }
        }
        continue
      }

      if (upper.startsWith('BED_MESH_PROFILE ')) {
        const loadMatch = /LOAD=([A-Za-z0-9_-]+)/i.exec(line)
        const saveMatch = /SAVE=([A-Za-z0-9_-]+)/i.exec(line)
        if (loadMatch) {
          const name = loadMatch[1]!
          if (bedMeshProfiles.has(name)) {
            activeMeshName = name
            responses.push(`// Loaded bed mesh '${name}'`)
            statusDirty = true
          } else {
            responses.push(`!! Unknown bed mesh profile ${name}`)
          }
        } else if (saveMatch) {
          const name = saveMatch[1]!
          const current =
            (activeMeshName && bedMeshProfiles.get(activeMeshName)) ||
            defaultMesh
          bedMeshProfiles.set(name, {
            ...current,
            name,
            points: current.points.map((row) => [...row]),
          })
          activeMeshName = name
          responses.push(`// Saved bed mesh '${name}'`)
          statusDirty = true
        }
        continue
      }

      if (upper.startsWith('BED_MESH_CALIBRATE')) {
        probeZ = 0.01
        responses.push('// Bed mesh calibrate complete')
        statusDirty = true
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
      } else {
        responses.push(`// echo: ${line}`)
      }
    }

    if (touchedExtruder) patch.extruders = nextExtruders
    if (Object.keys(patch).length > 0) {
      updateModel(patch)
    } else if (statusDirty) {
      broadcastStatus()
    }
    for (const response of responses) {
      broadcastGcodeResponse(response)
    }
    if (responses.length === 0 && script.trim()) {
      broadcastGcodeResponse('ok')
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
        'power',
        'proc_stats',
        'spoolman',
        'update_manager',
        'webcam',
        ...(timelapseEnabled ? ['timelapse'] : []),
        ...(authConfig ? ['authorization'] : []),
      ],
      websockets: wsClients.size,
      websockets_count: wsClients.size,
    }
  }

  function fileKey(root: MoonrakerFileRoot, path: string) {
    return `${root}:${path}`
  }

  function splitRootPath(
    raw: string,
    fallbackRoot: MoonrakerFileRoot = 'gcodes',
  ): { root: MoonrakerFileRoot; path: string } | null {
    const trimmed = raw.replace(/^\/+/, '')
    const slash = trimmed.indexOf('/')
    if (slash === -1) {
      if (
        trimmed === 'gcodes' ||
        trimmed === 'config' ||
        trimmed === 'timelapse'
      ) {
        return { root: trimmed, path: '' }
      }
      const safe = safeFilePath(trimmed)
      return safe ? { root: fallbackRoot, path: safe } : null
    }
    const maybeRoot = trimmed.slice(0, slash)
    const rest = trimmed.slice(slash + 1)
    if (
      maybeRoot === 'gcodes' ||
      maybeRoot === 'config' ||
      maybeRoot === 'timelapse'
    ) {
      if (!rest) return { root: maybeRoot, path: '' }
      const safe = safeFilePath(rest)
      return safe ? { root: maybeRoot, path: safe } : null
    }
    const safe = safeFilePath(trimmed)
    return safe ? { root: fallbackRoot, path: safe } : null
  }

  function findGcodeFile(filename: string): StoredMoonrakerFile | undefined {
    const direct = filesMap.get(fileKey('gcodes', filename))
    if (direct) return direct
    for (const file of filesMap.values()) {
      if (file.root === 'gcodes' && file.path === filename) return file
    }
    return undefined
  }

  function fileListResult(root: MoonrakerFileRoot = 'gcodes') {
    return [...filesMap.values()]
      .filter((f) => f.root === root)
      .map((f) => ({
        path: f.path,
        size: f.size,
        modified: f.modified,
        permissions: 'rw',
      }))
  }

  function fileMetadataResult(filename: string) {
    const file = findGcodeFile(filename)
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

  function refreshJobQueueTimes() {
    const now = Date.now() / 1000
    for (const job of jobQueue.jobs) {
      job.time_in_queue = Math.max(0, now - job.time_added)
    }
  }

  function jobQueueStatus() {
    refreshJobQueueTimes()
    return {
      queued_jobs: jobQueue.jobs.map((j) => ({ ...j })),
      queue_state: jobQueue.state,
    }
  }

  // A print that ends is recorded in history, as Moonraker does. End times
  // strictly increase so newest-first ordering stays stable.
  let printStartedAt = Date.now() / 1000
  let lastHistoryEnd = 0
  function recordPrintTransition(patch: Partial<MoonrakerModel>) {
    const active = model.state === 'printing' || model.state === 'paused'
    if (patch.state === 'printing' && !active) {
      printStartedAt = Date.now() / 1000
      printSourceStartedAt = eventtime
      return
    }
    if (
      !active ||
      (patch.state !== 'complete' &&
        patch.state !== 'cancelled' &&
        patch.state !== 'error')
    )
      return
    const end = Math.max(Date.now() / 1000, lastHistoryEnd + 0.001)
    lastHistoryEnd = end
    historyJobs.push({
      job_id: (historyJobs.length + 1).toString(16).padStart(6, '0'),
      filename: patch.filename ?? model.filename,
      status: patch.state === 'complete' ? 'completed' : patch.state,
      start_time: printStartedAt,
      end_time: end,
      print_duration: patch.printDuration ?? model.printDuration,
      total_duration: patch.totalDuration ?? model.totalDuration,
      filament_used: 0,
      exists: true,
      metadata: {},
    })
  }

  function historyListResult(params: Record<string, unknown> = {}) {
    const limit =
      typeof params.limit === 'number' && params.limit > 0
        ? Math.min(params.limit, 100)
        : 50
    const start =
      typeof params.start === 'number' && params.start >= 0 ? params.start : 0
    const since =
      typeof params.since === 'number' ? params.since : Number.NEGATIVE_INFINITY
    const before =
      typeof params.before === 'number'
        ? params.before
        : Number.POSITIVE_INFINITY
    const order = params.order === 'asc' ? 'asc' : 'desc'
    const filtered = historyJobs
      .filter((job) => {
        const end = job.end_time ?? 0
        return end >= since && end <= before
      })
      .sort((a, b) => {
        const ae = a.end_time ?? 0
        const be = b.end_time ?? 0
        return order === 'asc' ? ae - be : be - ae
      })
    const page = filtered.slice(start, start + limit)
    // Moonraker reports the total matching jobs, not the page size.
    return { count: filtered.length, jobs: page }
  }

  function historyTotalsResult() {
    let totalJobs = 0
    let totalTime = 0
    let totalPrintTime = 0
    let totalFilament = 0
    let longestJob = 0
    let longestPrint = 0
    for (const job of historyJobs) {
      if (!job.end_time) continue
      totalJobs++
      const total = job.total_duration ?? 0
      const print = job.print_duration ?? 0
      totalTime += total
      totalPrintTime += print
      totalFilament += job.filament_used ?? 0
      longestJob = Math.max(longestJob, total)
      longestPrint = Math.max(longestPrint, print)
    }
    return {
      job_totals: {
        total_jobs: totalJobs,
        total_time: totalTime,
        total_print_time: totalPrintTime,
        total_filament_used: totalFilament,
        longest_job: longestJob,
        longest_print: longestPrint,
      },
      auxiliary_totals: [],
    }
  }

  function temperatureStoreResult() {
    return { ...temperatureStore }
  }

  function procStatsResult() {
    const now = Date.now() / 1000
    return {
      moonraker_stats: [
        { time: now - 1, cpu_usage: 2.5, memory: 24000, mem_units: 'kB' },
        { time: now, cpu_usage: 2.6, memory: 24100, mem_units: 'kB' },
      ],
      throttled_state: { bits: 0, flags: [] },
      cpu_temp: 42.5,
      network: {
        lo: { rx_bytes: 1000, tx_bytes: 1000, bandwidth: 10 },
      },
      system_cpu_usage: { cpu: 3.1, cpu0: 3.1 },
      system_memory: {
        total: 8_000_000,
        available: 4_000_000,
        used: 4_000_000,
      },
      system_uptime: 12_345,
      websocket_connections: wsClients.size,
    }
  }

  function powerDevicesResult() {
    return {
      devices: [...powerDevices.values()].map((d) => ({ ...d })),
    }
  }

  function setPowerDevices(
    names: string[],
    state: 'on' | 'off',
  ): Record<string, string> | { error: string } {
    const out: Record<string, string> = {}
    for (const name of names) {
      const device = powerDevices.get(name)
      if (!device) return { error: `Unknown device ${name}` }
      if (
        device.locked_while_printing &&
        (model.state === 'printing' || model.state === 'paused') &&
        state === 'off'
      ) {
        return { error: `Device ${name} locked while printing` }
      }
      device.status = state
      out[name] = state
    }
    return out
  }

  /** Single-device power API (`machine.device_power.{get,post}_device`). */
  function devicePowerRpc(
    method: string,
    params: Record<string, unknown>,
  ): { result: unknown } | { error: string } | null {
    if (
      method !== 'machine.device_power.get_device' &&
      method !== 'machine.device_power.post_device'
    )
      return null
    const name = typeof params.device === 'string' ? params.device : ''
    const device = powerDevices.get(name)
    if (!device) return { error: `Unknown device ${name}` }
    if (method === 'machine.device_power.get_device')
      return { result: { device: name, status: device.status } }
    const action = params.action
    const next =
      action === 'toggle'
        ? device.status === 'on'
          ? 'off'
          : 'on'
        : action === 'on' || action === 'off'
          ? action
          : null
    if (!next) return { error: `Invalid power action ${String(action)}` }
    const result = setPowerDevices([name], next)
    if (typeof result.error === 'string' && !(name in result))
      return { error: result.error }
    return { result: { device: name, status: device.status } }
  }

  function getDirectoryResult(rawPath: string) {
    const parsed = splitRootPath(rawPath || 'gcodes')
    if (!parsed) return null
    const { root, path: dirPath } = parsed
    const prefix = dirPath ? `${dirPath}/` : ''
    const dirs = [...directories]
      .filter((key) => key.startsWith(`${root}:`))
      .map((key) => key.slice(root.length + 1))
      .filter((p) => {
        if (!dirPath) return !p.includes('/')
        if (!p.startsWith(prefix)) return false
        const rest = p.slice(prefix.length)
        return rest.length > 0 && !rest.includes('/')
      })
      .map((p) => ({
        modified: Math.floor(Date.now() / 1000),
        size: 4096,
        ...directoryStats.get(fileKey(root, p)),
        permissions: 'rw',
        dirname: dirPath ? p.slice(prefix.length) : p,
      }))
    const files = [...filesMap.values()]
      .filter((f) => f.root === root)
      .filter((f) => {
        if (!dirPath) return !f.path.includes('/')
        if (!f.path.startsWith(prefix)) return false
        const rest = f.path.slice(prefix.length)
        return rest.length > 0 && !rest.includes('/')
      })
      .map((f) => ({
        modified: f.modified,
        size: f.size,
        permissions: 'rw',
        filename: dirPath ? f.path.slice(prefix.length) : f.path,
      }))
    return {
      dirs,
      files,
      disk_usage: {
        total: 64 * 1024 * 1024,
        used: 8 * 1024 * 1024,
        free: 56 * 1024 * 1024,
      },
      root_info: { name: root, permissions: 'rw' },
    }
  }

  function createDirectory(rawPath: string) {
    const parsed = splitRootPath(rawPath)
    if (!parsed || !parsed.path) return { error: 'Invalid path' as const }
    directories.add(fileKey(parsed.root, parsed.path))
    return {
      item: {
        path: parsed.path,
        root: parsed.root,
        modified: Math.floor(Date.now() / 1000),
        size: 4096,
        permissions: 'rw',
      },
      action: 'create_dir' as const,
    }
  }

  function deleteFileOrDir(rawPath: string) {
    const parsed = splitRootPath(rawPath)
    if (!parsed || !parsed.path) return { error: 'Invalid path' as const }
    if (
      parsed.root === 'gcodes' &&
      model.filename === parsed.path &&
      (model.state === 'printing' || model.state === 'paused')
    ) {
      return { error: 'File is in use' as const }
    }
    const key = fileKey(parsed.root, parsed.path)
    if (filesMap.delete(key)) {
      return {
        item: {
          path: parsed.path,
          root: parsed.root,
          size: 0,
          modified: 0,
          permissions: '',
        },
        action: 'delete_file' as const,
      }
    }
    if (directories.delete(key)) {
      for (const fileKeyName of [...filesMap.keys()]) {
        if (
          fileKeyName.startsWith(`${parsed.root}:`) &&
          fileKeyName
            .slice(parsed.root.length + 1)
            .startsWith(`${parsed.path}/`)
        ) {
          filesMap.delete(fileKeyName)
        }
      }
      for (const dirKey of [...directories]) {
        if (
          dirKey.startsWith(`${parsed.root}:`) &&
          dirKey.slice(parsed.root.length + 1).startsWith(`${parsed.path}/`)
        ) {
          directories.delete(dirKey)
        }
      }
      return {
        item: {
          path: parsed.path,
          root: parsed.root,
          size: 0,
          modified: 0,
          permissions: '',
        },
        action: 'delete_dir' as const,
      }
    }
    return { error: 'Not found' as const }
  }

  function moveFileOrDir(sourceRaw: string, destRaw: string) {
    const source = splitRootPath(sourceRaw)
    const dest = splitRootPath(destRaw)
    if (!source?.path || !dest?.path) return { error: 'Invalid path' as const }
    if (source.root !== dest.root)
      return { error: 'Cross-root move refused' as const }
    if (
      source.root === 'gcodes' &&
      model.filename === source.path &&
      (model.state === 'printing' || model.state === 'paused')
    ) {
      return { error: 'File is in use' as const }
    }
    const sourceKey = fileKey(source.root, source.path)
    const destKey = fileKey(dest.root, dest.path)
    const file = filesMap.get(sourceKey)
    if (file) {
      filesMap.delete(sourceKey)
      const moved = {
        ...file,
        path: dest.path,
        modified: Math.floor(Date.now() / 1000),
      }
      filesMap.set(destKey, moved)
      return {
        item: {
          root: dest.root,
          path: dest.path,
          modified: moved.modified,
          size: moved.size,
          permissions: 'rw',
        },
        source_item: { root: source.root, path: source.path },
        action: 'move_file' as const,
      }
    }
    if (directories.has(sourceKey)) {
      directories.delete(sourceKey)
      directories.add(destKey)
      for (const [key, value] of [...filesMap.entries()]) {
        if (!key.startsWith(`${source.root}:`)) continue
        const rel = key.slice(source.root.length + 1)
        if (rel === source.path || !rel.startsWith(`${source.path}/`)) continue
        filesMap.delete(key)
        const nextPath = dest.path + rel.slice(source.path.length)
        filesMap.set(fileKey(dest.root, nextPath), { ...value, path: nextPath })
      }
      return {
        item: {
          root: dest.root,
          path: dest.path,
          modified: Math.floor(Date.now() / 1000),
          size: 4096,
          permissions: 'rw',
        },
        source_item: { root: source.root, path: source.path },
        action: 'move_dir' as const,
      }
    }
    return { error: 'Not found' as const }
  }

  // `server.files.post_directory` creates the directory like createDirectory
  // but records deterministic zero stats, so listings stay stable in tests.
  function postDirectory(rawPath: string) {
    const result = createDirectory(rawPath)
    if ('error' in result) return result
    const { root, path } = result.item
    directoryStats.set(fileKey(root, path), { modified: 0, size: 0 })
    return {
      ...result,
      item: { ...result.item, modified: 0, size: 0 },
    }
  }

  // Mirrors Moonraker's `server.files.copy`: duplicates a file or a
  // directory tree within one root and acknowledges with create_file/create_dir.
  function copyFileOrDir(sourceRaw: string, destRaw: string) {
    const source = splitRootPath(sourceRaw)
    const dest = splitRootPath(destRaw)
    if (!source?.path || !dest?.path) return { error: 'Invalid path' as const }
    if (source.root !== dest.root)
      return { error: 'Cross-root copy refused' as const }
    const modified = Math.floor(Date.now() / 1000)
    const file = filesMap.get(fileKey(source.root, source.path))
    if (file) {
      const copied = { ...file, path: dest.path, modified }
      filesMap.set(fileKey(dest.root, dest.path), copied)
      return {
        item: {
          root: dest.root,
          path: dest.path,
          modified,
          size: copied.size,
          permissions: 'rw',
        },
        action: 'create_file' as const,
      }
    }
    if (directories.has(fileKey(source.root, source.path))) {
      const sourcePrefix = `${source.path}/`
      const nestedDirs = [...directories]
        .filter((key) => key.startsWith(`${source.root}:`))
        .map((key) => key.slice(source.root.length + 1))
        .filter((rel) => rel.startsWith(sourcePrefix))
      const nestedFiles = [...filesMap.values()].filter(
        (f) => f.root === source.root && f.path.startsWith(sourcePrefix),
      )
      directories.add(fileKey(dest.root, dest.path))
      for (const rel of nestedDirs) {
        directories.add(
          fileKey(dest.root, dest.path + rel.slice(source.path.length)),
        )
      }
      for (const nested of nestedFiles) {
        const nextPath = dest.path + nested.path.slice(source.path.length)
        filesMap.set(fileKey(dest.root, nextPath), {
          ...nested,
          path: nextPath,
          modified,
        })
      }
      return {
        item: {
          root: dest.root,
          path: dest.path,
          modified,
          size: 4096,
          permissions: 'rw',
        },
        action: 'create_dir' as const,
      }
    }
    return { error: 'Not found' as const }
  }

  function readBodyJson(body: Buffer): Record<string, unknown> | null {
    if (body.length === 0) return {}
    try {
      const parsed = JSON.parse(body.toString('utf8')) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
      return null
    } catch {
      return null
    }
  }

  function parsePowerDeviceNames(url: URL, body: Buffer): string[] {
    const names = [...url.searchParams.keys()].filter((k) => k !== '')
    if (names.length > 0) return names
    const json = readBodyJson(body)
    if (!json) return []
    if (typeof json.device === 'string') return [json.device]
    if (Array.isArray(json.devices)) {
      return json.devices.filter((d): d is string => typeof d === 'string')
    }
    return Object.keys(json)
  }

  function postJobQueue(filenames: string[], reset = false) {
    if (reset) jobQueue.jobs = []
    const now = Date.now() / 1000
    for (const filename of filenames) {
      if (!findGcodeFile(filename)) {
        return { error: `File not found: ${filename}` as const }
      }
      jobQueue.jobs.push({
        filename,
        job_id: String(nextJobId++).padStart(16, '0'),
        time_added: now,
        time_in_queue: 0,
      })
    }
    return jobQueueStatus()
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
      const rootParam = url.searchParams.get('root')
      const root: MoonrakerFileRoot =
        rootParam === 'config' || rootParam === 'timelapse'
          ? rootParam
          : 'gcodes'
      sendJson(res, 200, { result: fileListResult(root) })
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

    if (path === '/server/files/directory' && method === 'GET') {
      const dirPath = url.searchParams.get('path') ?? 'gcodes'
      const result = getDirectoryResult(dirPath)
      if (!result) {
        sendJson(res, 400, { error: { code: 400, message: 'Invalid path' } })
        return
      }
      sendJson(res, 200, { result })
      return
    }

    if (path === '/server/files/directory' && method === 'POST') {
      const json = readBodyJson(body) ?? {}
      const dirPath =
        (typeof json.path === 'string' ? json.path : null) ??
        url.searchParams.get('path')
      if (!dirPath) {
        sendJson(res, 400, { error: { code: 400, message: 'Missing path' } })
        return
      }
      const result = createDirectory(dirPath)
      if ('error' in result) {
        sendJson(res, 400, { error: { code: 400, message: result.error } })
        return
      }
      sendJson(res, 200, { result })
      return
    }

    if (path === '/server/files/directory' && method === 'DELETE') {
      const dirPath = url.searchParams.get('path') ?? ''
      const result = deleteFileOrDir(dirPath)
      if ('error' in result) {
        sendJson(res, result.error === 'Not found' ? 404 : 400, {
          error: {
            code: result.error === 'Not found' ? 404 : 400,
            message: result.error,
          },
        })
        return
      }
      sendJson(res, 200, { result })
      return
    }

    if (path === '/server/files/move' && method === 'POST') {
      const json = readBodyJson(body) ?? {}
      const source =
        (typeof json.source === 'string' ? json.source : null) ??
        url.searchParams.get('source')
      const dest =
        (typeof json.dest === 'string' ? json.dest : null) ??
        url.searchParams.get('dest')
      if (!source || !dest) {
        sendJson(res, 400, {
          error: { code: 400, message: 'Missing source or dest' },
        })
        return
      }
      const result = moveFileOrDir(source, dest)
      if ('error' in result) {
        sendJson(res, 400, { error: { code: 400, message: result.error } })
        return
      }
      sendJson(res, 200, { result })
      return
    }

    if (path === '/server/files/delete' && method === 'DELETE') {
      const filePath = url.searchParams.get('path') ?? ''
      const result = deleteFileOrDir(filePath)
      if ('error' in result) {
        sendJson(res, result.error === 'Not found' ? 404 : 400, {
          error: {
            code: result.error === 'Not found' ? 404 : 400,
            message: result.error,
          },
        })
        return
      }
      sendJson(res, 200, { result })
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
        const root: MoonrakerFileRoot =
          parsed.root === 'config' || parsed.root === 'timelapse'
            ? parsed.root
            : 'gcodes'
        const entry: StoredMoonrakerFile = {
          path: safe,
          root,
          size: parsed.content.length,
          modified: Math.floor(Date.now() / 1000),
          content: parsed.content,
          thumbnails: new Map(),
        }
        filesMap.set(fileKey(root, safe), entry)
        if (parsed.startPrint && isKlippyReady() && root === 'gcodes') {
          updateModel({
            state: 'printing',
            filename: safe,
            progress: 0,
            errorMessage: '',
          })
        }
        sendJson(res, 201, {
          result: {
            item: { path: safe, root },
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

    for (const rootName of ['gcodes', 'config', 'timelapse'] as const) {
      const prefix = `/server/files/${rootName}/`
      if (!path.startsWith(prefix)) continue
      const rel = safeFilePath(path.slice(prefix.length))
      if (!rel) {
        sendJson(res, 400, { error: { code: 400, message: 'Invalid path' } })
        return
      }
      if (method === 'DELETE') {
        const result = deleteFileOrDir(`${rootName}/${rel}`)
        if ('error' in result) {
          sendJson(res, result.error === 'Not found' ? 404 : 400, {
            error: {
              code: result.error === 'Not found' ? 404 : 400,
              message: result.error,
            },
          })
          return
        }
        sendJson(res, 200, { result })
        return
      }
      if (method === 'GET') {
        const direct = filesMap.get(fileKey(rootName, rel))
        if (direct) {
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': direct.content.length,
          })
          res.end(direct.content)
          return
        }
        for (const file of filesMap.values()) {
          if (file.root !== rootName) continue
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

    if (path === '/server/temperature_store' && method === 'GET') {
      sendJson(res, 200, { result: temperatureStoreResult() })
      return
    }

    if (path === '/server/history/list' && method === 'GET') {
      const params: Record<string, unknown> = {}
      const limit = url.searchParams.get('limit')
      const start = url.searchParams.get('start')
      const since = url.searchParams.get('since')
      const before = url.searchParams.get('before')
      const order = url.searchParams.get('order')
      if (limit) params.limit = Number(limit)
      if (start) params.start = Number(start)
      if (since) params.since = Number(since)
      if (before) params.before = Number(before)
      if (order) params.order = order
      sendJson(res, 200, { result: historyListResult(params) })
      return
    }

    if (path === '/server/history/totals' && method === 'GET') {
      sendJson(res, 200, { result: historyTotalsResult() })
      return
    }

    if (path === '/server/job_queue/status' && method === 'GET') {
      sendJson(res, 200, { result: jobQueueStatus() })
      return
    }

    if (path === '/server/job_queue/job' && method === 'POST') {
      const json = readBodyJson(body) ?? {}
      const filenames = Array.isArray(json.filenames)
        ? json.filenames.filter((f): f is string => typeof f === 'string')
        : typeof json.filename === 'string'
          ? [json.filename]
          : []
      const result = postJobQueue(filenames, json.reset === true)
      if ('error' in result) {
        sendJson(res, 400, { error: { code: 400, message: result.error } })
        return
      }
      sendJson(res, 200, { result })
      return
    }

    if (path === '/server/job_queue/job' && method === 'DELETE') {
      const ids = url.searchParams.getAll('job_ids')
      jobQueue.jobs = jobQueue.jobs.filter((j) => !ids.includes(j.job_id))
      sendJson(res, 200, { result: jobQueueStatus() })
      return
    }

    if (path === '/server/job_queue/pause' && method === 'POST') {
      jobQueue.state = 'paused'
      sendJson(res, 200, { result: jobQueueStatus() })
      return
    }

    if (path === '/server/job_queue/start' && method === 'POST') {
      jobQueue.state = 'ready'
      if (
        jobQueue.jobs.length > 0 &&
        model.state === 'standby' &&
        isKlippyReady()
      ) {
        const next = jobQueue.jobs.shift()!
        updateModel({
          state: 'printing',
          filename: next.filename,
          progress: 0,
          errorMessage: '',
        })
        jobQueue.state = 'loading'
      }
      sendJson(res, 200, { result: jobQueueStatus() })
      return
    }

    if (path === '/server/job_queue/jump' && method === 'POST') {
      const json = readBodyJson(body) ?? {}
      const jobId =
        (typeof json.job_id === 'string' ? json.job_id : null) ??
        url.searchParams.get('job_id')
      if (!jobId) {
        sendJson(res, 400, { error: { code: 400, message: 'Missing job_id' } })
        return
      }
      const idx = jobQueue.jobs.findIndex((j) => j.job_id === jobId)
      if (idx > 0) {
        const [job] = jobQueue.jobs.splice(idx, 1)
        jobQueue.jobs.unshift(job!)
      }
      sendJson(res, 200, { result: jobQueueStatus() })
      return
    }

    if (path === '/machine/device_power/device') {
      const devicePower = devicePowerRpc(
        method === 'GET'
          ? 'machine.device_power.get_device'
          : method === 'POST'
            ? 'machine.device_power.post_device'
            : '',
        {
          ...(readBodyJson(body) ?? {}),
          ...Object.fromEntries(url.searchParams.entries()),
        },
      )
      if (devicePower) {
        if ('error' in devicePower)
          sendJson(res, 400, {
            error: { code: 400, message: devicePower.error },
          })
        else sendJson(res, 200, devicePower)
        return
      }
    }

    if (path === '/machine/device_power/devices' && method === 'GET') {
      sendJson(res, 200, { result: powerDevicesResult() })
      return
    }

    if (
      (path === '/machine/device_power/on' ||
        path === '/machine/device_power/off' ||
        path === '/machine/device_power/status') &&
      (method === 'GET' || method === 'POST')
    ) {
      const names = parsePowerDeviceNames(url, body)
      if (path.endsWith('/status')) {
        const out: Record<string, string> = {}
        for (const name of names) {
          const device = powerDevices.get(name)
          if (!device) {
            sendJson(res, 404, {
              error: { code: 404, message: `Unknown device ${name}` },
            })
            return
          }
          out[name] = device.status
        }
        sendJson(res, 200, { result: out })
        return
      }
      const state = path.endsWith('/on') ? 'on' : 'off'
      const result = setPowerDevices(names, state)
      if ('error' in result) {
        sendJson(res, 400, { error: { code: 400, message: result.error } })
        return
      }
      sendJson(res, 200, { result })
      return
    }

    if (path === '/machine/proc_stats' && method === 'GET') {
      sendJson(res, 200, { result: procStatsResult() })
      return
    }

    if (path === '/machine/services/restart' && method === 'POST') {
      const json = readBodyJson(body) ?? {}
      const service =
        (typeof json.service === 'string' ? json.service : null) ??
        url.searchParams.get('service') ??
        'klipper'
      if (service === 'klipper' || service === 'moonraker') {
        if (service === 'klipper') triggerRestart()
        sendJson(res, 200, { result: 'ok' })
        return
      }
      sendJson(res, 400, {
        error: { code: 400, message: `Service ${service} not allowed` },
      })
      return
    }

    if (timelapseEnabled) {
      const aliased = serverTimelapseHttp[`${method} ${path}`]
      if (aliased) {
        const params: Record<string, unknown> = {
          ...(readBodyJson(body) ?? {}),
          ...Object.fromEntries(url.searchParams.entries()),
        }
        const handled = serverTimelapse(aliased, params)
        if (handled) {
          sendJson(res, 200, handled)
          return
        }
      }
      if (path === '/machine/timelapse/settings') {
        if (method === 'GET') {
          sendJson(res, 200, { result: { ...timelapseSettings } })
          return
        }
        if (method === 'POST') {
          const json = readBodyJson(body) ?? {}
          for (const [key, value] of Object.entries(json)) {
            timelapseSettings[key] = value
          }
          for (const [key, value] of url.searchParams.entries()) {
            timelapseSettings[key] = value
          }
          sendJson(res, 200, { result: { ...timelapseSettings } })
          return
        }
      }
      if (path === '/machine/timelapse/lastframeinfo' && method === 'GET') {
        sendJson(res, 200, {
          result: {
            framecount: timelapseFramecount,
            lastframefile: timelapseLastFrame,
          },
        })
        return
      }
      if (path === '/machine/timelapse/render' && method === 'POST') {
        const filename = `timelapse-${Date.now()}.mp4`
        storeFileEntry(
          { path: filename, content: Buffer.from('mock-timelapse') },
          'timelapse',
          filesMap,
        )
        timelapseLastFrame = filename
        timelapseFramecount = 0
        sendJson(res, 200, {
          result: { status: 'success', filename },
        })
        return
      }
      if (path === '/machine/timelapse/saveframes' && method === 'POST') {
        sendJson(res, 200, { result: { status: 'success' } })
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

    if (path === '/printer/gcode/help' && method === 'GET') {
      sendJson(res, 200, { result: { ...gcodeHelp } })
      return
    }

    if (path === '/printer/gcode/help' && method === 'GET') {
      sendJson(res, 200, { result: { ...gcodeHelp } })
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
        const rootParam = (reqObj.params as { root?: unknown } | undefined)
          ?.root
        const root: MoonrakerFileRoot =
          rootParam === 'config' || rootParam === 'timelapse'
            ? rootParam
            : 'gcodes'
        reply(fileListResult(root))
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

      if (method === 'server.files.get_directory') {
        const dirPath =
          (reqObj.params as { path?: unknown } | undefined)?.path ?? 'gcodes'
        if (typeof dirPath !== 'string') {
          replyError(-32602, 'Invalid path')
          return
        }
        const result = getDirectoryResult(dirPath)
        if (!result) {
          replyError(-32602, 'Invalid path')
          return
        }
        reply(result)
        return
      }

      // Moonraker's documented JSON-RPC name for creating a directory; used by
      // the Connector file manager.
      if (method === 'server.files.post_directory') {
        const dirPath = (reqObj.params as { path?: unknown } | undefined)?.path
        if (typeof dirPath !== 'string') {
          replyError(-32602, 'Invalid path')
          return
        }
        const result = postDirectory(dirPath)
        if ('error' in result) {
          replyError(-32602, result.error)
          return
        }
        reply(result)
        return
      }

      if (method === 'server.files.create_directory') {
        const dirPath = (reqObj.params as { path?: unknown } | undefined)?.path
        if (typeof dirPath !== 'string') {
          replyError(-32602, 'Invalid path')
          return
        }
        const result = createDirectory(dirPath)
        if ('error' in result) {
          replyError(-32602, result.error)
          return
        }
        reply(result)
        return
      }

      if (method === 'server.files.delete_file') {
        const filePath = (reqObj.params as { path?: unknown } | undefined)?.path
        if (typeof filePath !== 'string') {
          replyError(-32602, 'Invalid path')
          return
        }
        const result = deleteFileOrDir(filePath)
        if ('error' in result) {
          replyError(-32602, result.error)
          return
        }
        reply(result)
        return
      }

      if (method === 'server.files.delete_directory') {
        const dirPath = (reqObj.params as { path?: unknown } | undefined)?.path
        if (typeof dirPath !== 'string') {
          replyError(-32602, 'Invalid path')
          return
        }
        const result = deleteFileOrDir(dirPath)
        if ('error' in result) {
          replyError(-32602, result.error)
          return
        }
        reply(result)
        return
      }

      if (method === 'server.files.move') {
        const params = reqObj.params as
          { source?: unknown; dest?: unknown } | undefined
        if (
          typeof params?.source !== 'string' ||
          typeof params?.dest !== 'string'
        ) {
          replyError(-32602, 'Invalid source or dest')
          return
        }
        const result = moveFileOrDir(params.source, params.dest)
        if ('error' in result) {
          replyError(-32602, result.error)
          return
        }
        reply(result)
        return
      }

      if (method === 'server.files.copy') {
        const params = reqObj.params as
          { source?: unknown; dest?: unknown } | undefined
        if (
          typeof params?.source !== 'string' ||
          typeof params?.dest !== 'string'
        ) {
          replyError(-32602, 'Invalid source or dest')
          return
        }
        const result = copyFileOrDir(params.source, params.dest)
        if ('error' in result) {
          replyError(-32602, result.error)
          return
        }
        reply(result)
        return
      }

      if (method === 'server.temperature_store') {
        reply(temperatureStoreResult())
        return
      }

      if (method === 'server.history.list') {
        reply(
          historyListResult(
            (reqObj.params as Record<string, unknown> | undefined) ?? {},
          ),
        )
        return
      }

      if (method === 'server.history.totals') {
        reply(historyTotalsResult())
        return
      }

      if (method === 'server.job_queue.status') {
        reply(jobQueueStatus())
        return
      }

      if (method === 'server.job_queue.post_job') {
        const params = reqObj.params as
          { filenames?: unknown; reset?: unknown } | undefined
        const filenames = Array.isArray(params?.filenames)
          ? params.filenames.filter((f): f is string => typeof f === 'string')
          : []
        const result = postJobQueue(filenames, params?.reset === true)
        if ('error' in result) {
          replyError(-32602, result.error)
          return
        }
        reply(result)
        return
      }

      if (method === 'server.job_queue.delete_job') {
        const params = reqObj.params as { job_ids?: unknown } | undefined
        const ids = Array.isArray(params?.job_ids)
          ? params.job_ids.filter((id): id is string => typeof id === 'string')
          : []
        jobQueue.jobs = jobQueue.jobs.filter((j) => !ids.includes(j.job_id))
        reply(jobQueueStatus())
        return
      }

      if (method === 'server.job_queue.pause') {
        jobQueue.state = 'paused'
        reply(jobQueueStatus())
        return
      }

      if (method === 'server.job_queue.start') {
        jobQueue.state = 'ready'
        if (
          jobQueue.jobs.length > 0 &&
          model.state === 'standby' &&
          isKlippyReady()
        ) {
          const next = jobQueue.jobs.shift()!
          updateModel({
            state: 'printing',
            filename: next.filename,
            progress: 0,
            errorMessage: '',
          })
          jobQueue.state = 'loading'
        }
        reply(jobQueueStatus())
        return
      }

      if (method === 'server.job_queue.jump') {
        const jobId = (reqObj.params as { job_id?: unknown } | undefined)
          ?.job_id
        if (typeof jobId !== 'string') {
          replyError(-32602, 'Invalid job_id')
          return
        }
        const idx = jobQueue.jobs.findIndex((j) => j.job_id === jobId)
        if (idx > 0) {
          const [job] = jobQueue.jobs.splice(idx, 1)
          jobQueue.jobs.unshift(job!)
        }
        reply(jobQueueStatus())
        return
      }

      if (method === 'machine.device_power.devices') {
        reply(powerDevicesResult())
        return
      }

      const devicePower = devicePowerRpc(
        method,
        (reqObj.params as Record<string, unknown> | undefined) ?? {},
      )
      if (devicePower) {
        if ('error' in devicePower) replyError(-32602, devicePower.error)
        else reply(devicePower.result)
        return
      }

      if (
        method === 'machine.device_power.on' ||
        method === 'machine.device_power.off' ||
        method === 'machine.device_power.status'
      ) {
        const params =
          (reqObj.params as Record<string, unknown> | undefined) ?? {}
        const names =
          typeof params.device === 'string'
            ? [params.device]
            : Array.isArray(params.devices)
              ? params.devices.filter((d): d is string => typeof d === 'string')
              : Object.keys(params)
        if (method === 'machine.device_power.status') {
          const out: Record<string, string> = {}
          for (const name of names) {
            const device = powerDevices.get(name)
            if (!device) {
              replyError(-32602, `Unknown device ${name}`)
              return
            }
            out[name] = device.status
          }
          reply(out)
          return
        }
        const result = setPowerDevices(
          names,
          method === 'machine.device_power.on' ? 'on' : 'off',
        )
        if ('error' in result) {
          replyError(-32602, result.error)
          return
        }
        reply(result)
        return
      }

      if (method === 'machine.proc_stats') {
        reply(procStatsResult())
        return
      }

      if (method === 'machine.services.restart') {
        const service = (reqObj.params as { service?: unknown } | undefined)
          ?.service
        if (service !== 'klipper' && service !== 'moonraker') {
          replyError(-32602, `Service ${String(service)} not allowed`)
          return
        }
        if (service === 'klipper') triggerRestart()
        reply('ok')
        return
      }

      if (timelapseEnabled) {
        const handled = serverTimelapse(
          method,
          (reqObj.params as Record<string, unknown> | undefined) ?? {},
        )
        if (handled) {
          reply(handled.result)
          return
        }
        if (method === 'machine.timelapse.settings') {
          const params =
            (reqObj.params as Record<string, unknown> | undefined) ?? {}
          for (const [key, value] of Object.entries(params)) {
            timelapseSettings[key] = value
          }
          reply({ ...timelapseSettings })
          return
        }
        if (method === 'machine.timelapse.lastframeinfo') {
          reply({
            framecount: timelapseFramecount,
            lastframefile: timelapseLastFrame,
          })
          return
        }
        if (method === 'machine.timelapse.render') {
          const filename = `timelapse-${Date.now()}.mp4`
          storeFileEntry(
            { path: filename, content: Buffer.from('mock-timelapse') },
            'timelapse',
            filesMap,
          )
          timelapseLastFrame = filename
          timelapseFramecount = 0
          reply({ status: 'success', filename })
          return
        }
        if (method === 'machine.timelapse.saveframes') {
          reply({ status: 'success' })
          return
        }
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

      if (method === 'printer.gcode.help') {
        reply({ ...gcodeHelp })
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

  const filesView = new Proxy(filesMap, {
    get(target, prop, receiver) {
      if (prop === 'get') {
        return (key: string) =>
          target.get(key) ??
          target.get(fileKey('gcodes', key)) ??
          target.get(fileKey('config', key)) ??
          target.get(fileKey('timelapse', key))
      }
      if (prop === 'has') {
        return (key: string) =>
          target.has(key) ||
          target.has(fileKey('gcodes', key)) ||
          target.has(fileKey('config', key)) ||
          target.has(fileKey('timelapse', key))
      }
      if (prop === 'delete') {
        return (key: string) => {
          if (target.delete(key)) return true
          if (target.delete(fileKey('gcodes', key))) return true
          if (target.delete(fileKey('config', key))) return true
          return target.delete(fileKey('timelapse', key))
        }
      }
      if (prop === 'set') {
        return (key: string, value: StoredMoonrakerFile) => {
          const root = value.root ?? 'gcodes'
          const pathKey = key.includes(':') ? key : fileKey(root, key)
          return target.set(pathKey, {
            ...value,
            root,
            path: value.path || key,
          })
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as Map<string, StoredMoonrakerFile>

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
      files: filesView,
      directories,
      historyJobs,
      jobQueue,
      powerDevices,
      setKlippyState,
      disconnectClients: () => {
        for (const client of [...wsClients]) {
          client.socket.destroy()
        }
      },
      completePrint: () => updateModel({ state: 'complete', progress: 1 }),
      failPrint: (message = 'Print failed') =>
        updateModel({ state: 'error', errorMessage: message }),
      broadcastGcodeResponse,
    },
    calls: callsFn as MoonrakerMockInstance['calls'],
    close,
  }
}
