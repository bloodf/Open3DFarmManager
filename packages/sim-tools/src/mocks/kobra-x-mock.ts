// SPDX-License-Identifier: MIT
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  X509Certificate,
} from 'node:crypto'
import dgram from 'node:dgram'
import { type TLSSocket } from 'node:tls'
import { startCameraMock } from '../camera-mock.ts'
import { FaultController } from './faults.ts'
import { startHttpMock, type HttpMockInstance } from './http-mock.ts'
import {
  generateKobraXThrowawayTls,
  generateWrongKobraXClientCert,
  getSharedKobraXTls,
  type KobraXTlsMaterial,
} from './kobra-x-tls.ts'
import {
  encodePacket,
  matchMqttTopic,
  startMqttBroker,
  type MqttMessage,
  type MqttMockInstance,
} from './mqtt-broker.ts'
import { assertLoopbackAddress } from './network-guard.ts'
import { ScenarioController, type ScenarioStep } from './scenario.ts'
import type { ThrowawayTlsMaterial } from './tls.ts'

export {
  generateKobraXThrowawayTls,
  generateWrongKobraXClientCert,
  getSharedKobraXTls,
  type KobraXTlsMaterial,
}

export type KobraXPrintState =
  'idle' | 'printing' | 'paused' | 'finished' | 'error'

export type KobraXJobPhase =
  | 'checking'
  | 'printing'
  | 'hotbed_heating'
  | 'nozzle_heating'
  | 'ace_filament_unfeeding'
  | 'ace_filament_feeding'
  | 'nozzle_purging'
  | 'nozzle_wiping'
  | 'nozzle_cooling'
  | 'auto_leveling'
  | 'z_offset_calibrating'
  | 'frequency_sweeping'
  | 'hotbed_cooling_off'
  | 'nozzle_cooling_off'
  | 'finished'
  | 'paused'
  | 'stoped'

export const KOBRA_X_PREPARATION_PHASES: readonly KobraXJobPhase[] = [
  'checking',
  'hotbed_heating',
  'nozzle_heating',
  'ace_filament_feeding',
  'auto_leveling',
  'z_offset_calibrating',
  'frequency_sweeping',
  'nozzle_purging',
  'nozzle_wiping',
]

export const KOBRA_X_REPORT_TYPES = [
  'info',
  'status',
  'print',
  'tempature',
  'multiColorBox',
  'light',
  'fan',
  'file',
  'axis',
  'skip',
  'video',
] as const

export type KobraXReportType =
  (typeof KOBRA_X_REPORT_TYPES)[number] | 'extfilbox' | 'properties'

export type KobraXClientKind = 'slicer' | 'web'

export interface KobraXAceSlot {
  index: number
  brand_name: string
  color: [number, number, number]
  consumables_percent: number
  material_name: string
  status: number
  type: string
  weight: number
}

export interface KobraXAceDryingStatus {
  status: number
  target_temp: number
  duration: number
  remain_time: number
}

export interface KobraXAceBox {
  id: number
  auto_feed: number
  drying_status: KobraXAceDryingStatus
  humidity: number
  temp: number
  loaded_slot: number
  model_id: string
  slots: KobraXAceSlot[]
}

export interface KobraXUploadedFile {
  filename: string
  content: Buffer
  size: number
  uploadedAt: number
}

export interface KobraXVideoRecord {
  filename: string
  main_file_name: string
  createTime: number
  duration: number
  fileSize: number
  fileKey: string
  file_image: string
}

export interface KobraXCredentials {
  username: string
  password: string
  deviceId: string
  modeId: string
}

export interface KobraXInfoPayload {
  cn: string
  ctrlInfoUrl: string
  ctrlType: string
  deviceName: string
  deviceType: string
  env: string
  ip: string
  modelId: string
  modelName: string
  token: string
  usn: string
  zone: string
}

export interface KobraXAccessories {
  ace: boolean
  light: boolean
  fan: boolean
}

export interface KobraXMockState {
  state: KobraXPrintState
  infoState: 'free' | 'busy'
  jobPhase: KobraXJobPhase | null
  progress: number
  currLayer: number
  totalLayers: number
  filename?: string | undefined
  errorCode?: number | undefined
  errorMessage?: string | undefined
  extended: Record<string, unknown>
}

export interface KobraXMockOptions {
  serial?: string | undefined
  deviceId?: string | undefined
  modeId?: string | undefined
  modelId?: string | undefined
  token?: string | undefined
  credentials?: { username: string; password: string } | undefined
  initialState?: KobraXPrintState | undefined
  spoolHolder?: boolean | undefined
  /** `data` of the `extfilbox` reply. Without it the query goes unanswered. */
  externalSpool?: Record<string, unknown> | undefined
  /**
   * Accessories this synthetic printer reports. Each defaults to present. An
   * absent one is left out of every report, as hardware without it would.
   */
  accessories?: Partial<KobraXAccessories> | undefined
  /**
   * Synthetic, reference-derived (not captured): answer Connector requests with
   * a printer-made report `msgid` while the ack keeps the request's own, as
   * described in bloodf/kobracontrol@c414db4f36d4c96f2b232c368ad6cfe56e3d0408
   * docs/protocol.md, "Requests and replies". `commands` still echoes the IDs
   * of state queries (`query`, `getInfo`); `all` echoes none. Default: echo.
   */
  printerChosenReportIds?: 'commands' | 'all' | undefined
  /**
   * Synthetic, not captured: the reports selected by `printerChosenReportIds`
   * carry no `msgid` at all. No cited source observed this; it exercises the
   * missing-ID branch of `printer-assigned` (kobra-x/requests.ts).
   */
  omitReplacedReportIds?: boolean | undefined
  printDurationMs?: number | undefined
  preparationPhases?: readonly KobraXJobPhase[] | undefined
  preparationStepMs?: number | undefined
  trap10111DelayMs?: number | undefined
  reportIntervalMs?: number | undefined
  totalLayers?: number | undefined
  ssdp?: boolean | undefined
  ssdpPort?: number | undefined
  ssdpSocket?: dgram.Socket | undefined
  httpPort?: number | undefined
  mqttPort?: number | undefined
  camera?: boolean | undefined
  /**
   * Opt-in capture-gated HTTP-FLV. The stream is dark until MQTT
   * `video/startCapture`, which answers `data.urls.rtspUrl` with a distinct
   * synthetic token. `video/stopCapture` invalidates it and closes open FLV
   * responses. Default off: the always-live URL stays unchanged.
   */
  captureGatedFlv?: boolean | undefined
  strictCtrlQuery?: boolean | undefined
  requireMqttAuth?: boolean | undefined
  requireExactClientCert?: boolean | undefined
  tls?: ThrowawayTlsMaterial | KobraXTlsMaterial | undefined
  reuseSharedTls?: boolean | undefined
  scenario?: ScenarioStep<Partial<KobraXMockState>>[] | undefined
}

export interface KobraXMockInstance {
  origin: string
  mqttOrigin: string
  httpOrigin: string
  flvUrl: string | undefined
  ssdpHost: string
  ssdpPort: number | undefined
  httpPort: number
  mqttPort: number
  flvPort: number | undefined
  ports: {
    default: number
    mqtt: number
    http: number
    ssdp?: number | undefined
    flv?: number | undefined
  } & number[]
  credentials: KobraXCredentials & { token: string }
  tls: {
    serverCert: Buffer
    serverCertPath: string
    serverFingerprintSha256?: string | undefined
    clientCert: Buffer
    clientKey: Buffer
    clientCaCert: Buffer
    clientCertPath: string
    clientKeyPath: string
    clientCaCertPath: string
  }
  camera:
    | {
        /** Always-live URL; undefined in capture-gated mode. */
        flvUrl: string | undefined
        flvBase: string
        capture: Awaited<ReturnType<typeof startCameraMock>>['capture']
        rtspUrl: string
        cameraUrl: string
        state: { stall: boolean; disconnect: boolean }
      }
    | undefined
  control: {
    faults: FaultController
    scenario: ScenarioController<Partial<KobraXMockState>>
    publishReport: (data: unknown) => void
    publishAck: (msgid: string, clientKind?: KobraXClientKind) => void
    publishTypedReport: (
      type: KobraXReportType,
      action: string,
      data: unknown,
      options?: {
        msgid?: string
        code?: number
        state?: string
        msg?: string
        clientKind?: KobraXClientKind
      },
    ) => void
    /** Change which accessories the printer reports and publish a fresh info report. */
    setAccessories: (next: Partial<KobraXAccessories>) => void
    setState: (state: KobraXPrintState) => void
    setPrintProgress: (progress: number) => void
    setJobPhase: (
      phase: KobraXJobPhase,
      extra?: Record<string, unknown>,
    ) => void
    startPrint: (
      filename?: string,
      options?: {
        preparationPhases?: readonly KobraXJobPhase[]
        preparationStepMs?: number
        printDurationMs?: number
        taskid?: string
        msgid?: string
      },
    ) => Promise<void>
    finishPrint: () => void
    failPrint: (code?: number, msg?: string) => void
    aceFeed: (slotIndex: number) => void
    aceRetract: (slotIndex?: number) => void
    aceStartDrying: (options?: {
      targetTemp?: number
      duration?: number
      remainTime?: number
    }) => void
    aceStopDrying: () => void
    simulateSecondClientReport: (
      type: KobraXReportType,
      action: string,
      data: unknown,
      clientKind?: KobraXClientKind,
    ) => string
    disconnectClients: () => Promise<void>
    getAceState: () => KobraXAceBox
    getFiles: () => KobraXUploadedFile[]
    seedFile: (filename: string, content: Buffer | string) => void
    getVideos: () => KobraXVideoRecord[]
    addVideo: (video: KobraXVideoRecord) => void
    getMqttClientsCount: () => number
    getInfo: () => KobraXInfoPayload
    getState: () => KobraXMockState
  }
  calls: {
    (): Readonly<Record<string, number>>
    all: readonly MqttMessage[]
    http: HttpMockInstance['calls']['all']
    ssdp: readonly {
      st: string
      address: string
      port: number
      timestamp: number
    }[]
  }
  close: () => Promise<void>
}

function deriveCtrlAesKey(token: string): Buffer {
  const slice = token.slice(16)
  if (slice.length >= 16) return Buffer.from(slice.slice(0, 16), 'utf8')
  return Buffer.from(token.padEnd(16, '0').slice(0, 16), 'utf8')
}

export function decryptKobraXCtrlBlob(
  token: string,
  data: { token: string; info: string },
): KobraXCredentials {
  const key = deriveCtrlAesKey(token)
  const iv = Buffer.from(data.token, 'utf8')
  const decipher = createDecipheriv('aes-128-cbc', key, iv)
  const plain = Buffer.concat([
    decipher.update(Buffer.from(data.info, 'base64')),
    decipher.final(),
  ])
  return JSON.parse(plain.toString('utf8')) as KobraXCredentials
}

function defaultAceBox(): KobraXAceBox {
  return {
    id: 0,
    auto_feed: 1,
    drying_status: {
      status: 0,
      target_temp: 0,
      duration: 86400,
      remain_time: 0,
    },
    humidity: 22,
    temp: 25,
    loaded_slot: -1,
    model_id: 'ACE_PRO_SYNTHETIC',
    slots: [
      {
        index: 0,
        brand_name: 'Anycubic',
        color: [255, 255, 255],
        consumables_percent: 100,
        material_name: 'PLA',
        status: 5,
        type: 'PLA',
        weight: 1000,
      },
      {
        index: 1,
        brand_name: 'Anycubic',
        color: [0, 0, 0],
        consumables_percent: 85,
        material_name: 'PLA',
        status: 5,
        type: 'PLA',
        weight: 1000,
      },
      {
        index: 2,
        brand_name: 'Anycubic',
        color: [255, 0, 0],
        consumables_percent: 70,
        material_name: 'PETG',
        status: 5,
        type: 'PETG',
        weight: 1000,
      },
      {
        index: 3,
        brand_name: 'Anycubic',
        color: [0, 128, 255],
        consumables_percent: 50,
        material_name: 'PLA',
        status: 5,
        type: 'PLA',
        weight: 1000,
      },
    ],
  }
}

export async function startKobraXMock(
  options: KobraXMockOptions = {},
): Promise<KobraXMockInstance> {
  const rawSerial = options.serial ?? 'SYNTHETIC_KOBRA_X'
  const serialParts = rawSerial.includes('/') ? rawSerial.split('/') : undefined
  const modeId =
    options.modeId ?? options.modelId ?? serialParts?.[0] ?? '20030'
  const deviceId = options.deviceId ?? serialParts?.[1] ?? rawSerial
  const token = options.token ?? randomBytes(16).toString('hex')
  const credentials: KobraXCredentials = {
    username: options.credentials?.username ?? 'synthetic-kobra-x',
    password: options.credentials?.password ?? 'synthetic-kobra-x-password',
    deviceId,
    modeId,
  }
  const totalLayers = options.totalLayers ?? 100
  const preparationStepMs = options.preparationStepMs ?? 15
  const trap10111DelayMs = options.trap10111DelayMs ?? 20
  const faults = new FaultController()

  let state: KobraXPrintState = options.initialState ?? 'idle'
  let infoState: 'free' | 'busy' =
    state === 'printing' || state === 'paused' ? 'busy' : 'free'
  let jobPhase: KobraXJobPhase | null =
    state === 'printing'
      ? 'printing'
      : state === 'paused'
        ? 'paused'
        : state === 'finished'
          ? 'finished'
          : null
  let progress = state === 'finished' ? 100 : 0
  let currLayer = 0
  let printTimeSec = 0
  let remainTimeSec = 0
  let activeFilename: string | undefined =
    state === 'printing' || state === 'paused' ? 'synthetic.gcode' : undefined
  let activeTaskId = '-1'
  let nextTaskId = 0
  let errorCode: number | undefined
  let errorMessage: string | undefined
  let printerName = 'Anycubic Kobra X (Synthetic)'
  let fanSpeedPct = 0
  let lightState = { type: 3, status: 0, brightness: 0 }
  let tempState = {
    curr_nozzle_temp: 25,
    target_nozzle_temp: 0,
    curr_hotbed_temp: 24,
    target_hotbed_temp: 0,
  }
  let axisPosition = { x: 0, y: 0, z: 0 }
  let skippedObjects: number[] = []
  let videoCapturing = false
  let printSpeedMode = 2
  const aceBox: KobraXAceBox = defaultAceBox()
  const spoolHolder = options.spoolHolder
    ? { ...defaultAceBox(), id: -1, model_id: 'SPOOL_HOLDER_SYNTHETIC' }
    : undefined
  if (spoolHolder) spoolHolder.slots[3]!.consumables_percent = 0
  const accessories: KobraXAccessories = {
    ace: true,
    light: true,
    fan: true,
    ...options.accessories,
  }
  const colorBoxes = () =>
    accessories.ace
      ? structuredClone(spoolHolder ? [spoolHolder, aceBox] : [aceBox])
      : structuredClone(spoolHolder ? [spoolHolder] : [])
  const assistantSettings = [
    { option: 0, value: 1 },
    { option: 1, value: 1 },
    { option: 3, value: 1 },
    { option: 4, value: 1 },
    { option: 5, value: 1 },
  ]
  const uploadedFiles = new Map<string, KobraXUploadedFile>()
  const videoRecords: KobraXVideoRecord[] = [
    {
      filename: 'synthetic_timelapse.mp4',
      main_file_name: 'synthetic.gcode',
      createTime: Math.floor(Date.now() / 1000),
      duration: 12,
      fileSize: 65536,
      fileKey: 'synthetic-video-1',
      file_image: 'synthetic_timelapse.jpg',
    },
  ]
  const extended: Record<string, unknown> = {}
  const ssdpRequests: {
    st: string
    address: string
    port: number
    timestamp: number
  }[] = []
  const extraCallCounts: Record<string, number> = {}
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>()
  let printTimer: ReturnType<typeof setInterval> | undefined
  let periodicTimer: ReturnType<typeof setInterval> | undefined
  let reportSeq = 0
  let closed = false

  function recordExtraCall(key: string) {
    extraCallCounts[key] = (extraCallCounts[key] ?? 0) + 1
  }

  function stopPrintTimers() {
    if (printTimer) {
      clearInterval(printTimer)
      printTimer = undefined
    }
    for (const t of pendingTimers) {
      clearTimeout(t)
    }
    pendingTimers.clear()
  }

  function scheduleTimeout(fn: () => void, ms: number) {
    const timer = setTimeout(() => {
      pendingTimers.delete(timer)
      if (!closed) fn()
    }, ms)
    pendingTimers.add(timer)
    return timer
  }

  // 1. TLS material (self-signed server + generated test client certificate)
  let ownedTls: KobraXTlsMaterial | undefined
  let activeTls: ThrowawayTlsMaterial | KobraXTlsMaterial
  if (options.tls) {
    activeTls = options.tls
  } else if (options.reuseSharedTls) {
    activeTls = getSharedKobraXTls()
  } else {
    ownedTls = generateKobraXThrowawayTls()
    activeTls = ownedTls
  }

  const expectedClientRaw = Buffer.from(activeTls.client.cert)

  // 2. Camera mock (HTTP-FLV from E16.7)
  let cameraMock: Awaited<ReturnType<typeof startCameraMock>> | undefined
  if (options.camera !== false) {
    cameraMock = await startCameraMock({
      token,
      captureGated: options.captureGatedFlv === true,
    })
  }
  const flvUrl = cameraMock?.flvUrl
  const flvPort = cameraMock
    ? Number(new URL(cameraMock.flvBase).port)
    : undefined
  /** URL announced to clients: always-live, or the active capture session's. */
  const announcedFlvUrl = (): string | undefined => {
    if (!cameraMock) return undefined
    if (!cameraMock.capture.gated) return flvUrl
    const captureToken = cameraMock.capture.token()
    return captureToken === undefined
      ? undefined
      : `${cameraMock.flvBase}/live/${captureToken}`
  }

  // 3. HTTP 18910 (/info, /ctrl, /gcode_upload)
  let httpPort = 0
  const getInfoPayload = (): KobraXInfoPayload => ({
    cn: deviceId,
    ctrlInfoUrl: `http://127.0.0.1:${httpPort}/ctrl`,
    ctrlType: 'lan',
    deviceName: printerName,
    deviceType: 'fdm',
    env: 'release',
    ip: '127.0.0.1',
    modelId: modeId,
    modelName: 'Anycubic Kobra X',
    token,
    usn: `SYNTHETIC-KOBRA-X-${deviceId}`,
    zone: 'local',
  })

  const httpMock = await startHttpMock({
    port: options.httpPort,
    faults,
    routes: {
      '/info': (req, res) => {
        if (req.method !== 'GET') {
          res.writeHead(405).end()
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(getInfoPayload()))
      },
      '/ctrl': (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405).end()
          return
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (options.strictCtrlQuery) {
          const ts = url.searchParams.get('ts') ?? ''
          const nonce = url.searchParams.get('nonce') ?? ''
          const sign = url.searchParams.get('sign') ?? ''
          const did = url.searchParams.get('did') ?? ''
          if (
            !/^\d{10,13}$/.test(ts) ||
            !/^[A-Za-z0-9_-]{4,32}$/.test(nonce) ||
            !/^[a-fA-F0-9]{16,64}$/.test(sign) ||
            !did
          ) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ code: 400, message: 'invalid params' }))
            return
          }
        }
        const iv = randomBytes(8).toString('hex')
        const key = deriveCtrlAesKey(token)
        const cipher = createCipheriv(
          'aes-128-cbc',
          key,
          Buffer.from(iv, 'utf8'),
        )
        const info = Buffer.concat([
          cipher.update(JSON.stringify(credentials)),
          cipher.final(),
        ]).toString('base64')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            code: 200,
            message: 'success',
            data: { token: iv, info },
          }),
        )
      },
      '/gcode_upload': async (req, res, body) => {
        if (req.method !== 'POST') {
          res.writeHead(405).end()
          return
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (url.searchParams.get('s') !== token) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ code: 401, message: 'unauthorized' }))
          return
        }
        const contentType = req.headers['content-type'] ?? ''
        if (!contentType.toLowerCase().includes('multipart/form-data')) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ code: 400, message: 'multipart required' }))
          return
        }
        let uploaded: File | undefined
        try {
          const form = await new Request('http://127.0.0.1/gcode_upload', {
            method: 'POST',
            headers: { 'content-type': contentType },
            body: new Uint8Array(body),
          }).formData()
          for (const [, value] of form.entries()) {
            if (value instanceof File) {
              uploaded = value
              break
            }
          }
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ code: 400, message: 'invalid multipart' }))
          return
        }
        if (!uploaded) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ code: 400, message: 'missing file' }))
          return
        }
        const content = Buffer.from(await uploaded.arrayBuffer())
        uploadedFiles.set(uploaded.name, {
          filename: uploaded.name,
          content,
          size: content.length,
          uploadedAt: Date.now(),
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            code: 200,
            data: { gcode: uploaded.name },
            message: 'success',
          }),
        )
      },
    },
  })
  httpPort = httpMock.ports.default

  // 4. SSDP Responder
  let ssdpSocket: dgram.Socket | undefined
  let ownsSsdpSocket = false
  let ssdpPort: number | undefined
  let ssdpListener: ((msg: Buffer, rinfo: dgram.RemoteInfo) => void) | undefined

  if (options.ssdp !== false) {
    ssdpSocket = options.ssdpSocket ?? dgram.createSocket('udp4')
    ownsSsdpSocket = !options.ssdpSocket
    ssdpSocket.on('error', () => {})

    ssdpListener = (msg: Buffer, rinfo: dgram.RemoteInfo) => {
      const text = msg.toString('utf8')
      const lines = text.split(/\r?\n/)
      const firstLine = (lines[0] ?? '').trim()
      if (!/^M-SEARCH\b/i.test(firstLine)) {
        return
      }
      let st = ''
      for (const line of lines.slice(1)) {
        const idx = line.indexOf(':')
        if (idx > 0 && line.slice(0, idx).trim().toUpperCase() === 'ST') {
          st = line.slice(idx + 1).trim()
          break
        }
      }
      if (
        st &&
        st !== 'ssdp:all' &&
        st !== 'upnp:rootdevice' &&
        !st.startsWith('ac:3dprinter:')
      ) {
        return
      }
      ssdpRequests.push({
        st: st || 'ssdp:all',
        address: rinfo.address,
        port: rinfo.port,
        timestamp: Date.now(),
      })
      recordExtraCall('SSDP')
      recordExtraCall(`SSDP:${st || 'ssdp:all'}`)

      const fault = faults.matchFault({ path: '/ssdp', method: 'SSDP' })
      if (fault) {
        if (
          fault.type === 'drop' ||
          fault.type === 'refuse' ||
          fault.type === 'stall'
        ) {
          return
        }
        if (fault.type === 'malformed') {
          const bad = fault.payload
            ? Buffer.isBuffer(fault.payload)
              ? fault.payload
              : Buffer.from(fault.payload)
            : Buffer.from('HTTP/1.1 200 OK\r\nST: invalid\r\n\r\n')
          ssdpSocket?.send(bad, rinfo.port, rinfo.address)
          return
        }
        if (fault.type === 'delay') {
          scheduleTimeout(() => {
            ssdpSocket?.send(Buffer.alloc(0), rinfo.port, rinfo.address)
          }, fault.delayMs)
          return
        }
      }

      // Kobra X responds to M-SEARCH with exactly one empty 0-byte UDP datagram
      ssdpSocket?.send(Buffer.alloc(0), rinfo.port, rinfo.address)
    }

    ssdpSocket.on('message', ssdpListener)

    let alreadyBound = false
    try {
      const existing = ssdpSocket.address()
      if (existing && typeof existing !== 'string') {
        assertLoopbackAddress(existing)
        ssdpPort = existing.port
        alreadyBound = true
      }
    } catch {
      alreadyBound = false
    }

    if (!alreadyBound) {
      await new Promise<void>((resolve, reject) => {
        ssdpSocket!.once('error', reject)
        ssdpSocket!.bind(options.ssdpPort ?? 0, '127.0.0.1', () => {
          ssdpSocket!.removeListener('error', reject)
          resolve()
        })
      })
      const addr = ssdpSocket.address()
      assertLoopbackAddress(addr)
      ssdpPort = addr.port
    }
  }

  // 5. MQTT 3.1.1 over mutual TLS
  let brokerRef: MqttMockInstance | undefined

  function buildProjectPayload() {
    if (!activeFilename) return null
    const isPreparation =
      jobPhase !== null &&
      jobPhase !== 'printing' &&
      jobPhase !== 'paused' &&
      jobPhase !== 'finished' &&
      jobPhase !== 'stoped'
    return {
      filename: activeFilename,
      taskid: activeTaskId,
      state: jobPhase ?? state,
      progress: isPreparation ? 0 : progress,
      curr_layer: isPreparation ? 0 : currLayer,
      total_layers: totalLayers,
      print_time: isPreparation ? 0 : printTimeSec,
      remain_time: Math.ceil(remainTimeSec / 60),
      ...(errorCode !== undefined ? { error_code: errorCode } : {}),
    }
  }

  function buildInfoData() {
    return {
      state: infoState,
      printerName,
      deviceName: printerName,
      modelId: modeId,
      modelName: 'Anycubic Kobra X',
      version: '2.0.2.8-synthetic',
      project: buildProjectPayload(),
      last_project: null,
      features: {
        auto_leveling_support: true,
        vibration_compensation_support: true,
        flow_calibration_support: false,
        camera_timelapse_support: true,
      },
      urls: {
        ...(announcedFlvUrl() ? { rtspUrl: announcedFlvUrl() } : {}),
      },
      temp: { ...tempState },
      ...(accessories.fan ? { fan_speed_pct: fanSpeedPct } : {}),
      print_speed_mode: printSpeedMode,
      lights: accessories.light ? [{ ...lightState }] : [],
      multi_color_box: colorBoxes(),
      ...extended,
    }
  }

  function buildPrintData() {
    const project = buildProjectPayload()
    if (!project) return {}
    return {
      ...project,
      settings: {
        ...(accessories.fan ? { fan_speed_pct: fanSpeedPct } : {}),
        print_speed_mode: printSpeedMode,
      },
    }
  }

  // The Connector issues UUID request IDs and requires the answering report to
  // carry the same ID. Echo only those, set for the synchronous dispatch of one
  // request; other clients' IDs keep getting the mock's own report IDs.
  const connectorRequestId =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  let replyMsgid: string | undefined
  // Latest unanswered Connector request per type/action. A scripted report for
  // that type/action stands in for the printer's own answer and carries its ID.
  const openRequestIds = new Map<string, string>()
  /** Request IDs this printer answers with an ID of its own. */
  const replacedIds = new Set<string>()
  function nextMsgId() {
    reportSeq += 1
    return `printer-msg-${reportSeq}`
  }

  function emitWithLegacySuffixDelivery(
    suffix: string,
    payload: unknown,
    faultMethod: 'ACK' | 'REPORT',
  ) {
    if (!brokerRef) return
    // Real Kobra X reports and acks use `printer/public` with no `slicer/` or
    // `web/` segment. A subscription on the query prefix must not receive them.
    const topic = `anycubic/anycubicCloud/v1/printer/public/${modeId}/${deviceId}/${suffix}`
    const emitted = brokerRef.control.publish(topic, payload, 0, faultMethod)
    if (!emitted) return

    // Bare `<deviceId>/response` and `<type>/report` filters do not match the
    // printer topic. Deliver that alias only when the socket missed `topic`.
    const altTopic = suffix === 'response' ? `${deviceId}/response` : suffix
    const rawBuf = Buffer.from(
      typeof payload === 'string' ? payload : JSON.stringify(payload),
    )

    for (const [sock, topics] of brokerRef.control.subscriptions.entries()) {
      if (!sock.writable) continue
      let alreadyMatched = false
      for (const filter of topics) {
        if (matchMqttTopic(filter, topic)) {
          alreadyMatched = true
          break
        }
      }
      if (alreadyMatched) continue
      let matchedAlt = false
      for (const filter of topics) {
        if (matchMqttTopic(filter, altTopic)) {
          matchedAlt = true
          break
        }
      }
      if (!matchedAlt) continue
      const tBuf = Buffer.from(altTopic)
      const lBuf = Buffer.alloc(2)
      lBuf.writeUInt16BE(tBuf.length)
      sock.write(encodePacket(0x30, Buffer.concat([lBuf, tBuf, rawBuf])))
    }
  }

  function publishAck(msgid: string, _clientKind: KobraXClientKind = 'slicer') {
    emitWithLegacySuffixDelivery(
      'response',
      {
        type: '',
        action: '',
        msgid,
        timestamp: Date.now(),
        code: 0,
        msg: 'success',
        data: null,
      },
      'ACK',
    )
  }

  function publishTypedReport(
    type: KobraXReportType,
    action: string,
    data: unknown,
    reportOptions: {
      msgid?: string
      code?: number
      state?: string
      msg?: string
      clientKind?: KobraXClientKind
    } = {},
  ) {
    const echoed = reportOptions.msgid ?? replyMsgid
    const replaced = echoed !== undefined && replacedIds.has(echoed)
    const body = {
      type,
      action,
      // `undefined` drops the key from the serialized report.
      msgid:
        replaced && options.omitReplacedReportIds
          ? undefined
          : echoed === undefined || replaced
            ? nextMsgId()
            : echoed,
      timestamp: Date.now(),
      state: reportOptions.state ?? 'done',
      code: reportOptions.code ?? 200,
      msg: reportOptions.msg ?? 'success',
      data,
    }
    emitWithLegacySuffixDelivery(`${type}/report`, body, 'REPORT')
  }

  function startAdvancingPrint(durationMs?: number) {
    if (durationMs === undefined || durationMs <= 0) return
    if (printTimer) clearInterval(printTimer)
    const startedAt = Date.now()
    const baseProgress = progress
    printTimer = setInterval(
      () => {
        if (state !== 'printing' || jobPhase !== 'printing') return
        const elapsed = Date.now() - startedAt
        const frac = Math.min(1, elapsed / durationMs)
        progress = Math.min(
          100,
          Math.floor(baseProgress + frac * (100 - baseProgress)),
        )
        currLayer = Math.floor((progress * totalLayers) / 100)
        printTimeSec = Math.floor(elapsed / 1000)
        remainTimeSec = Math.max(0, Math.ceil((durationMs - elapsed) / 1000))
        if (progress >= 100) {
          finishPrint()
          return
        }
        publishTypedReport('print', 'start', buildPrintData(), {
          state: 'printing',
        })
      },
      Math.max(10, Math.min(50, durationMs / 10)),
    )
  }

  async function startPrintScenario(
    filename = 'synthetic.gcode',
    opts: {
      preparationPhases?: readonly KobraXJobPhase[]
      preparationStepMs?: number
      printDurationMs?: number
      taskid?: string
      msgid?: string
    } = {},
  ) {
    stopPrintTimers()
    activeFilename = filename
    activeTaskId = opts.taskid ?? '-1'
    errorCode = undefined
    errorMessage = undefined
    infoState = 'busy'
    state = 'printing'
    progress = 0
    currLayer = 0
    printTimeSec = 0
    remainTimeSec = 0

    const phases =
      opts.preparationPhases ??
      options.preparationPhases ??
      KOBRA_X_PREPARATION_PHASES
    const stepMs = opts.preparationStepMs ?? preparationStepMs

    for (const phase of phases) {
      if (closed || state !== 'printing') return
      jobPhase = phase
      publishTypedReport('print', 'start', buildPrintData(), {
        state: phase,
        ...(opts.msgid ? { msgid: opts.msgid } : {}),
      })
      if (stepMs > 0) {
        await new Promise<void>((resolve) => scheduleTimeout(resolve, stepMs))
      }
    }

    if (closed || state !== 'printing') return
    jobPhase = 'printing'
    publishTypedReport('print', 'start', buildPrintData(), {
      state: 'printing',
      ...(opts.msgid ? { msgid: opts.msgid } : {}),
    })
    startAdvancingPrint(opts.printDurationMs ?? options.printDurationMs)
  }

  function finishPrint() {
    stopPrintTimers()
    state = 'finished'
    jobPhase = 'finished'
    progress = 100
    currLayer = totalLayers
    remainTimeSec = 0
    publishTypedReport('print', 'start', buildPrintData(), {
      state: 'finished',
    })
    infoState = 'free'
    activeFilename = undefined
    publishTypedReport('info', 'report', buildInfoData(), { state: 'done' })
  }

  function failPrint(code = 10111, msg = 'abnormal end of task') {
    stopPrintTimers()
    state = 'error'
    jobPhase = 'stoped'
    errorCode = code
    errorMessage = msg
    publishTypedReport('print', 'start', buildPrintData(), {
      state: 'stoped',
      code,
      msg,
    })
    infoState = 'free'
    activeFilename = undefined
    publishTypedReport('info', 'report', buildInfoData(), { state: 'done' })
  }

  const broker = await startMqttBroker({
    port: options.mqttPort,
    faults,
    tls: {
      key: activeTls.server.key,
      cert: activeTls.server.cert,
      ca: activeTls.ca.cert,
    },
    ca: activeTls.ca.cert,
    requestCert: true,
    rejectUnauthorized: true,
    validateClientCert: (socket: TLSSocket) => {
      if (options.requireExactClientCert === false) {
        return socket.authorized
      }
      const peer = socket.getPeerCertificate()
      if (!peer || !peer.raw) return false
      const expectedX509Raw = new X509Certificate(expectedClientRaw).raw
      return Buffer.compare(peer.raw, expectedX509Raw) === 0
    },
    auth: options.requireMqttAuth === false ? undefined : credentials,
    authorizeSubscribe: (topic) =>
      topic === '#' ||
      topic === 'anycubic/anycubicCloud/v1/#' ||
      topic ===
        `anycubic/anycubicCloud/v1/printer/public/${modeId}/${deviceId}/#` ||
      topic === `${deviceId}/response` ||
      topic.endsWith('/report'),
    onPublish: async (msg) => {
      const cmdMatch =
        /^anycubic\/anycubicCloud\/v1\/(slicer|web)\/printer\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(
          msg.topic,
        )
      const legacyCmdTopic = `anycubic/anycubicCloud/v1/printer/public/${deviceId}/cmd/request`
      if (!cmdMatch && msg.topic !== legacyCmdTopic) return

      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(msg.payload.toString('utf8')) as Record<
          string,
          unknown
        >
      } catch {
        return
      }

      if (msg.topic === legacyCmdTopic) {
        const cmd = parsed.cmd ?? parsed.command
        if (cmd === 'pause') {
          state = 'paused'
          jobPhase = 'paused'
          stopPrintTimers()
        } else if (cmd === 'resume') {
          state = 'printing'
          jobPhase = 'printing'
        } else if (cmd === 'stop' || cmd === 'cancel') {
          state = 'idle'
          infoState = 'free'
          jobPhase = null
          activeFilename = undefined
          stopPrintTimers()
        }
        publishTypedReport('info', 'report', buildInfoData())
        return
      }

      const clientKind = cmdMatch![1] as KobraXClientKind
      const topicMode = cmdMatch![2]!
      const topicDevice = cmdMatch![3]!
      const topicType = cmdMatch![4]! as KobraXReportType
      if (topicMode !== modeId || topicDevice !== deviceId) return

      const msgid =
        typeof parsed.msgid === 'string' && parsed.msgid
          ? parsed.msgid
          : `req-${Date.now()}`
      const action = typeof parsed.action === 'string' ? parsed.action : ''
      const data =
        parsed.data && typeof parsed.data === 'object'
          ? (parsed.data as Record<string, unknown>)
          : {}

      // 1. Immediate ACK on <deviceId>/response
      publishAck(msgid, clientKind)

      const mode = options.printerChosenReportIds
      if (
        mode === 'all' ||
        (mode === 'commands' && action !== 'query' && action !== 'getInfo')
      )
        replacedIds.add(msgid)

      // 2. Dispatch per message type
      replyMsgid = connectorRequestId.test(msgid) ? msgid : undefined
      if (replyMsgid) openRequestIds.set(`${topicType}/${action}`, replyMsgid)
      queueMicrotask(() => {
        replyMsgid = undefined
      })
      switch (topicType) {
        case 'info': {
          if (action === 'query') {
            publishTypedReport('info', 'report', buildInfoData(), {
              clientKind,
              msgid,
            })
          } else if (action === 'net') {
            publishTypedReport(
              'info',
              'net',
              {
                mac: '02:00:00:00:20:30',
                machine_mac: '02:00:00:00:20:30',
                ip: '127.0.0.1',
              },
              { clientKind, msgid },
            )
          } else if (action === 'statistic-query') {
            publishTypedReport(
              'info',
              'statistic-query',
              {
                print_total_minutes: 120,
                print_count: 3,
                material_used_gram_value: 250,
              },
              { clientKind, msgid },
            )
          } else if (action === 'setPrinterName') {
            if (typeof data.printerName === 'string' && data.printerName) {
              printerName = data.printerName
            }
            publishTypedReport(
              'info',
              'setPrinterName',
              { printerName },
              { clientKind, msgid },
            )
          } else {
            publishTypedReport('info', action || 'report', buildInfoData(), {
              clientKind,
              msgid,
            })
          }
          break
        }

        case 'status': {
          publishTypedReport(
            'status',
            action || 'query',
            {
              state: infoState,
              job_phase: jobPhase,
              temp: { ...tempState },
              project: buildProjectPayload(),
            },
            { clientKind, msgid },
          )
          break
        }

        case 'print': {
          if (action === 'query') {
            // Spec: print/query on an idle printer returns ack without report
            if (infoState === 'free' && !activeFilename) {
              return
            }
            publishTypedReport('print', 'query', buildPrintData(), {
              state: jobPhase ?? state,
              clientKind,
              msgid,
            })
          } else if (action === 'start') {
            const filepath =
              typeof data.filepath === 'string' ? data.filepath : '/'
            const filename =
              typeof data.filename === 'string' && data.filename
                ? data.filename
                : 'synthetic.gcode'
            const taskid = typeof data.taskid === 'string' ? data.taskid : '-1'
            if (filepath !== '/') {
              activeFilename = filename
              activeTaskId = taskid
              infoState = 'busy'
              state = 'printing'
              jobPhase = 'checking'
              publishTypedReport('print', 'start', buildPrintData(), {
                state: 'checking',
                clientKind,
                msgid,
              })
              scheduleTimeout(() => {
                failPrint(10111, 'abnormal end of task')
              }, trap10111DelayMs)
              return
            }
            void startPrintScenario(filename, {
              taskid: taskid === '-1' ? `job-${++nextTaskId}` : taskid,
              msgid,
            })
          } else if (action === 'pause') {
            state = 'paused'
            jobPhase = 'paused'
            if (printTimer) {
              clearInterval(printTimer)
              printTimer = undefined
            }
            publishTypedReport('print', 'pause', buildPrintData(), {
              state: 'paused',
              clientKind,
              msgid,
            })
          } else if (action === 'resume') {
            state = 'printing'
            jobPhase = 'printing'
            startAdvancingPrint(options.printDurationMs)
            publishTypedReport('print', 'resume', buildPrintData(), {
              state: 'printing',
              clientKind,
              msgid,
            })
          } else if (action === 'stop' || action === 'cancel') {
            stopPrintTimers()
            state = 'idle'
            jobPhase = 'stoped'
            publishTypedReport('print', action, buildPrintData(), {
              state: 'stoped',
              code: 200,
              clientKind,
              msgid,
            })
            infoState = 'free'
            activeFilename = undefined
          } else if (action === 'update') {
            const settings =
              data.settings && typeof data.settings === 'object'
                ? (data.settings as Record<string, unknown>)
                : {}
            if (typeof settings.fan_speed_pct === 'number') {
              fanSpeedPct = settings.fan_speed_pct
            }
            if (typeof settings.print_speed_mode === 'number') {
              printSpeedMode = settings.print_speed_mode
            }
            if (typeof settings.target_nozzle_temp === 'number') {
              tempState.target_nozzle_temp = settings.target_nozzle_temp
            }
            if (typeof settings.target_hotbed_temp === 'number') {
              tempState.target_hotbed_temp = settings.target_hotbed_temp
            }
            publishTypedReport('print', 'update', buildPrintData(), {
              clientKind,
              msgid,
            })
          } else {
            publishTypedReport('print', action || 'report', buildPrintData(), {
              state: jobPhase ?? state,
              clientKind,
              msgid,
            })
          }
          break
        }

        case 'tempature': {
          if (action === 'set') {
            if (typeof data.target_nozzle_temp === 'number') {
              tempState.target_nozzle_temp = data.target_nozzle_temp
              tempState.curr_nozzle_temp = data.target_nozzle_temp
            }
            if (typeof data.target_hotbed_temp === 'number') {
              tempState.target_hotbed_temp = data.target_hotbed_temp
              tempState.curr_hotbed_temp = data.target_hotbed_temp
            }
          }
          publishTypedReport(
            'tempature',
            action || 'query',
            { ...tempState },
            { clientKind, msgid },
          )
          break
        }

        case 'multiColorBox': {
          const targetBox = data.id === -1 ? spoolHolder : aceBox
          if (action === 'feed') {
            const slotIdx =
              typeof data.slot === 'number'
                ? data.slot
                : typeof data.index === 'number'
                  ? data.index
                  : 0
            if (targetBox) applyAceFeed(slotIdx, targetBox)
          } else if (action === 'retract' || action === 'unfeed') {
            const slotIdx =
              typeof data.slot === 'number'
                ? data.slot
                : typeof data.index === 'number'
                  ? data.index
                  : targetBox?.loaded_slot
            if (targetBox) applyAceRetract(slotIdx, targetBox)
          } else if (action === 'startDrying' || action === 'drying') {
            const targetTemp =
              typeof data.target_temp === 'number' ? data.target_temp : 55
            const duration =
              typeof data.duration === 'number' ? data.duration : 240
            applyAceStartDrying({ targetTemp, duration, remainTime: duration })
          } else if (action === 'stopDrying') {
            applyAceStopDrying()
          } else if (action === 'setAutoFeed') {
            if (typeof data.auto_feed === 'number') {
              aceBox.auto_feed = data.auto_feed
            } else if (typeof data.auto_feed === 'boolean') {
              aceBox.auto_feed = data.auto_feed ? 1 : 0
            }
          } else if (action === 'editSlot') {
            const slotIdx = typeof data.index === 'number' ? data.index : 0
            const slot = aceBox.slots[slotIdx]
            if (slot) {
              if (typeof data.brand_name === 'string') {
                slot.brand_name = data.brand_name
              }
              if (typeof data.material_name === 'string') {
                slot.material_name = data.material_name
              }
              if (typeof data.type === 'string') slot.type = data.type
              if (Array.isArray(data.color) && data.color.length >= 3) {
                slot.color = [
                  Number(data.color[0]),
                  Number(data.color[1]),
                  Number(data.color[2]),
                ]
              }
              if (typeof data.weight === 'number') slot.weight = data.weight
              if (typeof data.consumables_percent === 'number') {
                slot.consumables_percent = data.consumables_percent
              }
            }
          }
          publishTypedReport(
            'multiColorBox',
            action || 'getInfo',
            { multi_color_box: colorBoxes() },
            { clientKind, msgid },
          )
          break
        }

        case 'extfilbox': {
          if (options.externalSpool)
            publishTypedReport(
              'extfilbox',
              action || 'getInfo',
              { ...options.externalSpool },
              { clientKind },
            )
          break
        }

        case 'light': {
          if (action === 'control') {
            lightState = {
              type: typeof data.type === 'number' ? data.type : 3,
              status: typeof data.status === 'number' ? data.status : 0,
              brightness:
                typeof data.brightness === 'number'
                  ? data.brightness
                  : data.status === 1
                    ? 100
                    : 0,
            }
          }
          publishTypedReport(
            'light',
            action || 'control',
            { ...lightState },
            { clientKind, msgid },
          )
          break
        }

        case 'fan': {
          if (action === 'setSpeed' || action === 'control') {
            if (typeof data.fan_speed_pct === 'number') {
              fanSpeedPct = data.fan_speed_pct
            } else if (typeof data.speed === 'number') {
              fanSpeedPct = data.speed
            }
          }
          publishTypedReport(
            'fan',
            action || 'setSpeed',
            { fan_speed_pct: fanSpeedPct },
            { clientKind, msgid },
          )
          break
        }

        case 'file': {
          if (action === 'listLocal') {
            const records = [...uploadedFiles.values()].map((f) => ({
              filename: f.filename,
              size: f.size,
              timestamp: f.uploadedAt,
            }))
            publishTypedReport(
              'file',
              'listLocal',
              { records },
              { clientKind, msgid },
            )
          } else if (action === 'fileDetails') {
            const filename =
              typeof data.filename === 'string' ? data.filename : ''
            const file = uploadedFiles.get(filename)
            publishTypedReport(
              'file',
              'fileDetails',
              {
                root: typeof data.root === 'string' ? data.root : '/',
                filename,
                file_details: {
                  filename,
                  size: file?.size ?? 0,
                  layers: totalLayers,
                  print_time: 600,
                },
              },
              { clientKind, msgid },
            )
          } else if (action === 'delete' || action === 'deleteLocal') {
            const filename =
              typeof data.filename === 'string' ? data.filename : ''
            uploadedFiles.delete(filename)
            publishTypedReport(
              'file',
              action,
              { filename, deleted: true },
              { clientKind, msgid },
            )
          } else if (action === 'listVideo') {
            publishTypedReport(
              'file',
              'listVideo',
              { records: structuredClone(videoRecords) },
              { clientKind, msgid },
            )
          } else if (action === 'deleteVideo') {
            const filename =
              typeof data.filename === 'string' ? data.filename : ''
            const idx = videoRecords.findIndex((v) => v.filename === filename)
            if (idx >= 0) videoRecords.splice(idx, 1)
            publishTypedReport(
              'file',
              'deleteVideo',
              {
                path: typeof data.path === 'string' ? data.path : '/',
                filename,
              },
              { clientKind, msgid },
            )
          } else {
            publishTypedReport(
              'file',
              action || 'listLocal',
              { records: [] },
              { clientKind, msgid },
            )
          }
          break
        }

        case 'axis': {
          if (action === 'move') {
            const axis = typeof data.axis === 'number' ? data.axis : 5
            const moveType =
              typeof data.move_type === 'number' ? data.move_type : 2
            const distance =
              typeof data.distance === 'number' ? data.distance : 10
            if (axis === 5 && moveType === 2) {
              axisPosition = { x: 0, y: 0, z: 0 }
            } else {
              const delta = moveType === 1 ? distance : -distance
              if (axis === 1) axisPosition.x += delta
              else if (axis === 2) axisPosition.y += delta
              else if (axis === 3) axisPosition.z += delta
            }
            publishTypedReport(
              'axis',
              'move',
              { axis, move_type: moveType, position: { ...axisPosition } },
              { clientKind, msgid },
            )
          } else {
            publishTypedReport(
              'axis',
              action || 'query',
              { position: { ...axisPosition } },
              { clientKind, msgid },
            )
          }
          break
        }

        case 'skip': {
          if (Array.isArray(data.skipped_objects)) {
            skippedObjects = data.skipped_objects.filter(
              (n): n is number => typeof n === 'number',
            )
          } else if (typeof data.object_id === 'number') {
            if (!skippedObjects.includes(data.object_id)) {
              skippedObjects.push(data.object_id)
            }
          }
          publishTypedReport(
            'skip',
            action || 'query',
            { skipped_objects: [...skippedObjects] },
            { clientKind, msgid },
          )
          break
        }

        case 'video': {
          if (action === 'startCapture') {
            videoCapturing = true
          } else if (action === 'stopCapture') {
            videoCapturing = false
          }
          if (cameraMock?.capture.gated) {
            let rtspUrl: string | undefined
            if (action === 'startCapture') {
              rtspUrl = cameraMock.capture.start().url
            } else if (action === 'stopCapture') {
              cameraMock.capture.stop()
            } else {
              rtspUrl = announcedFlvUrl()
            }
            publishTypedReport(
              'video',
              action || 'startCapture',
              {
                urls: { ...(rtspUrl ? { rtspUrl } : {}) },
                active: cameraMock.capture.active(),
              },
              { clientKind, msgid },
            )
            break
          }
          publishTypedReport(
            'video',
            action || 'startCapture',
            {
              ...(flvUrl ? { rtspUrl: flvUrl } : {}),
              active: videoCapturing,
            },
            { clientKind, msgid },
          )
          break
        }

        case 'properties': {
          if (action === 'write' && Array.isArray(data.assistant_settings)) {
            for (const entry of data.assistant_settings) {
              if (
                entry &&
                typeof entry === 'object' &&
                typeof (entry as Record<string, unknown>).option === 'number'
              ) {
                const opt = (entry as Record<string, number>).option!
                const val = (entry as Record<string, number>).value ?? 0
                const existing = assistantSettings.find((s) => s.option === opt)
                if (existing) existing.value = val
                else assistantSettings.push({ option: opt, value: val })
              }
            }
          }
          publishTypedReport(
            'properties',
            action || 'read',
            { assistant_settings: structuredClone(assistantSettings) },
            { clientKind, msgid },
          )
          break
        }
      }
    },
  })
  brokerRef = broker

  function applyAceFeed(slotIndex: number, box = aceBox) {
    for (const slot of box.slots) {
      if (slot.index === slotIndex) slot.status = 5
    }
    box.loaded_slot = slotIndex
  }

  function applyAceRetract(slotIndex?: number, box = aceBox) {
    for (const slot of box.slots) {
      if (slotIndex === undefined || slot.index === slotIndex) {
        slot.status = 0
      }
    }
    if (slotIndex === undefined || box.loaded_slot === slotIndex) {
      box.loaded_slot = -1
    }
  }

  function applyAceStartDrying(opts: {
    targetTemp?: number
    duration?: number
    remainTime?: number
  }) {
    aceBox.drying_status = {
      status: 1,
      target_temp: opts.targetTemp ?? 55,
      duration: opts.duration ?? 240,
      remain_time: opts.remainTime ?? opts.duration ?? 240,
    }
  }

  function applyAceStopDrying() {
    aceBox.drying_status = {
      status: 0,
      target_temp: 0,
      duration: aceBox.drying_status.duration,
      remain_time: 0,
    }
  }

  const scenario = new ScenarioController<Partial<KobraXMockState>>({
    steps: options.scenario,
    applyState: (patch) => {
      if (patch.state !== undefined) state = patch.state
      if (patch.infoState !== undefined) infoState = patch.infoState
      if (patch.jobPhase !== undefined) jobPhase = patch.jobPhase
      if (patch.progress !== undefined) progress = patch.progress
      if (patch.currLayer !== undefined) currLayer = patch.currLayer
      if (patch.filename !== undefined) activeFilename = patch.filename
      if (patch.errorCode !== undefined) errorCode = patch.errorCode
      if (patch.errorMessage !== undefined) errorMessage = patch.errorMessage
      if (patch.extended) Object.assign(extended, patch.extended)
    },
    publishReport: (report) => {
      publishTypedReport('info', 'report', report)
    },
    getState: () => ({
      state,
      infoState,
      jobPhase,
      progress,
      currLayer,
      totalLayers,
      filename: activeFilename,
      errorCode,
      errorMessage,
      extended: { ...extended },
    }),
  })

  if (options.reportIntervalMs !== 0) {
    periodicTimer = setInterval(() => {
      if (state === 'printing' && !closed) {
        publishTypedReport('print', 'start', buildPrintData(), {
          state: jobPhase ?? 'printing',
        })
      }
    }, options.reportIntervalMs ?? 100)
  }

  const mqttPort = broker.ports.default
  const ports = Object.assign(
    [
      mqttPort,
      httpPort,
      ...(ssdpPort !== undefined ? [ssdpPort] : []),
      ...(flvPort !== undefined ? [flvPort] : []),
    ],
    {
      default: mqttPort,
      mqtt: mqttPort,
      http: httpPort,
      ...(ssdpPort !== undefined ? { ssdp: ssdpPort } : {}),
      ...(flvPort !== undefined ? { flv: flvPort } : {}),
    },
  ) as KobraXMockInstance['ports']

  const callsFn = () => ({ ...broker.calls(), ...extraCallCounts })
  Object.defineProperty(callsFn, 'all', {
    get: () => broker.calls.all,
  })
  Object.defineProperty(callsFn, 'http', {
    get: () => httpMock.calls.all,
  })
  Object.defineProperty(callsFn, 'ssdp', {
    get: () => ssdpRequests,
  })

  let closing: Promise<void> | undefined
  const close = () => {
    closing ??= (async () => {
      closed = true
      stopPrintTimers()
      if (periodicTimer) {
        clearInterval(periodicTimer)
        periodicTimer = undefined
      }
      scenario.stop()
      if (ssdpSocket) {
        if (ssdpListener) {
          ssdpSocket.off('message', ssdpListener)
        }
        if (ownsSsdpSocket) {
          await new Promise<void>((resolve) => {
            try {
              ssdpSocket!.close(() => resolve())
            } catch {
              resolve()
            }
          })
        }
      }
      await Promise.all([
        httpMock.close(),
        broker.close(),
        cameraMock ? cameraMock.close() : Promise.resolve(),
      ])
      if (ownedTls) {
        ownedTls.cleanup()
        ownedTls = undefined
      }
    })()
    return closing
  }

  return {
    origin: broker.origin,
    mqttOrigin: broker.origin,
    httpOrigin: httpMock.origin,
    flvUrl,
    ssdpHost: '127.0.0.1',
    ssdpPort,
    httpPort,
    mqttPort,
    flvPort,
    ports,
    credentials: { ...credentials, token },
    tls: {
      serverCert: activeTls.server.cert,
      serverCertPath: activeTls.server.certPath,
      serverFingerprintSha256:
        'serverFingerprintSha256' in activeTls
          ? activeTls.serverFingerprintSha256
          : undefined,
      clientCert: activeTls.client.cert,
      clientKey: activeTls.client.key,
      clientCaCert: activeTls.ca.cert,
      clientCertPath: activeTls.client.certPath,
      clientKeyPath: activeTls.client.keyPath,
      clientCaCertPath: activeTls.ca.certPath,
    },
    camera: cameraMock
      ? {
          flvUrl: cameraMock.flvUrl,
          flvBase: cameraMock.flvBase,
          capture: cameraMock.capture,
          rtspUrl: cameraMock.rtspUrl,
          cameraUrl: cameraMock.cameraUrl,
          state: cameraMock.state,
        }
      : undefined,
    control: {
      faults,
      scenario,
      publishReport: (data) => publishTypedReport('info', 'report', data),
      publishAck,
      publishTypedReport: (type, action, data, reportOptions = {}) => {
        // A scripted failure stands in for the printer's own answer to the
        // open request of that type/action, so it carries that request's ID.
        const failure =
          reportOptions.state === 'failed' ||
          (reportOptions.code !== undefined && reportOptions.code !== 200)
        const key = `${type}/${action}`
        const open = failure ? openRequestIds.get(key) : undefined
        if (open) openRequestIds.delete(key)
        publishTypedReport(type, action, data, {
          ...(open ? { msgid: open } : {}),
          ...reportOptions,
        })
      },
      setAccessories: (next) => {
        Object.assign(accessories, next)
        publishTypedReport('info', 'report', buildInfoData(), {
          state: 'done',
        })
        publishTypedReport(
          'multiColorBox',
          'getInfo',
          { multi_color_box: colorBoxes() },
          { state: 'done' },
        )
      },
      setState: (newState) => {
        state = newState
        infoState =
          newState === 'printing' || newState === 'paused' ? 'busy' : 'free'
        jobPhase =
          newState === 'printing'
            ? 'printing'
            : newState === 'paused'
              ? 'paused'
              : newState === 'finished'
                ? 'finished'
                : newState === 'error'
                  ? 'stoped'
                  : null
        publishTypedReport('info', 'report', buildInfoData())
      },
      setPrintProgress: (p) => {
        state = 'printing'
        infoState = 'busy'
        jobPhase = 'printing'
        progress = p
        currLayer = Math.floor((p * totalLayers) / 100)
        publishTypedReport('print', 'start', buildPrintData(), {
          state: 'printing',
        })
      },
      setJobPhase: (phase, extra) => {
        jobPhase = phase
        if (extra) Object.assign(extended, extra)
        if (phase === 'finished') {
          finishPrint()
          return
        }
        if (phase === 'stoped') {
          failPrint(
            typeof extra?.errorCode === 'number' ? extra.errorCode : 10111,
            typeof extra?.errorMessage === 'string'
              ? extra.errorMessage
              : 'abnormal end of task',
          )
          return
        }
        infoState = 'busy'
        state = phase === 'paused' ? 'paused' : 'printing'
        publishTypedReport('print', 'start', buildPrintData(), {
          state: phase,
        })
      },
      startPrint: startPrintScenario,
      finishPrint,
      failPrint,
      aceFeed: (slotIndex) => {
        applyAceFeed(slotIndex)
        publishTypedReport(
          'multiColorBox',
          'feed',
          { multi_color_box: [structuredClone(aceBox)] },
          { state: 'done' },
        )
      },
      aceRetract: (slotIndex) => {
        applyAceRetract(slotIndex)
        publishTypedReport(
          'multiColorBox',
          'retract',
          { multi_color_box: [structuredClone(aceBox)] },
          { state: 'done' },
        )
      },
      aceStartDrying: (dryOpts = {}) => {
        applyAceStartDrying(dryOpts)
        publishTypedReport(
          'multiColorBox',
          'startDrying',
          { multi_color_box: [structuredClone(aceBox)] },
          { state: 'done' },
        )
      },
      aceStopDrying: () => {
        applyAceStopDrying()
        publishTypedReport(
          'multiColorBox',
          'stopDrying',
          { multi_color_box: [structuredClone(aceBox)] },
          { state: 'done' },
        )
      },
      simulateSecondClientReport: (
        type,
        action,
        data,
        clientKind = 'slicer',
      ) => {
        const msgid = `other-client-${++reportSeq}`
        publishTypedReport(type, action, data, { msgid, clientKind })
        return msgid
      },
      disconnectClients: () => broker.control.disconnectClients(),
      getAceState: () => structuredClone(aceBox),
      getFiles: () =>
        [...uploadedFiles.values()].map((f) => ({
          ...f,
          content: Buffer.from(f.content),
        })),
      seedFile: (filename, content) => {
        const buf = Buffer.isBuffer(content)
          ? Buffer.from(content)
          : Buffer.from(content, 'utf8')
        uploadedFiles.set(filename, {
          filename,
          content: buf,
          size: buf.length,
          uploadedAt: Date.now(),
        })
      },
      getVideos: () => structuredClone(videoRecords),
      addVideo: (video) => {
        videoRecords.push(structuredClone(video))
      },
      getMqttClientsCount: () => broker.control.sockets.size,
      getInfo: getInfoPayload,
      getState: () => ({
        state,
        infoState,
        jobPhase,
        progress,
        currLayer,
        totalLayers,
        filename: activeFilename,
        errorCode,
        errorMessage,
        extended: { ...extended },
      }),
    },
    calls: callsFn as KobraXMockInstance['calls'],
    close,
  }
}
