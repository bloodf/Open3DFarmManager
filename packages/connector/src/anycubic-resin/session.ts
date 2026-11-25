import { randomUUID } from 'node:crypto'
import { MqttClient } from 'mqtt'
import { connectAnycubicTls, PinMismatch } from '../anycubic/tls-trust.ts'
import { photonP1MaxSources } from './models.ts'
import {
  applyPhotonResinReport,
  emptyPhotonResinReadings,
  parsePhotonResinReport,
  photonCameraStopped,
  type PhotonResinReadings,
  type PhotonResinReport,
} from './reports.ts'

const topicRoot = 'anycubic/anycubicCloud/v1'
const packetLimit = 262_144

export type PhotonResinCredentials = {
  host: string
  port: number
  deviceId: string
  clientId: string
  username: string
  password: string
}

export type PhotonResinCapability =
  | 'status'
  | 'job-report'
  | 'resin-temperature'
  | 'release-film-counter'
  | 'peripherals'
  | 'local-file-list'
  | 'camera'
  | 'usb-print-start'
  | 'print-stop'

export type PhotonResinState = PhotonResinReadings & {
  connected: boolean
  camera: { url: string; rotationDegrees: 270 } | null
}

/**
 * `confirmed` and `rejected` come from a printer report. `refused` sent no
 * command. `uncertain` means a command left and no report settled it; it is
 * never sent again by this module.
 */
export type PhotonResinCommandResult =
  | { outcome: 'confirmed'; state: PhotonResinState }
  | {
      outcome: 'rejected' | 'refused' | 'uncertain'
      reason: string
      state: PhotonResinState
    }

export const photonResinRefusals = {
  pause: `Pause is unsupported: the only P1 Max captures are a refused pause and a refused resume. ${photonP1MaxSources.print}`,
  resume: `Resume is unsupported: the only P1 Max captures are a refused pause and a refused resume. ${photonP1MaxSources.print}`,
  upload:
    'Upload is unsupported: no P1 Max upload request or authentication is documented. https://github.com/modrzew/hass-anycubic-photon-p1/blob/f33ceb5bc47388412a7a378ed58649736a5a6834/docs/protocol.md#port-18910-api',
  resinMetering: `Measured resin use is unsupported: supplies_usage is the job estimate at layer 0 and the captured Actual_volume is null. ${photonP1MaxSources.print}`,
} as const

type Waiter = {
  match: (report: PhotonResinReport) => boolean
  finish: (report: PhotonResinReport | undefined) => void
}

export async function openPhotonResinBrokerSession({
  credentials,
  pinSha256,
  cameraPort,
  connectTimeoutMs,
  commandTimeoutMs,
  signal,
}: {
  credentials: PhotonResinCredentials
  pinSha256: string
  cameraPort: number
  connectTimeoutMs: number
  commandTimeoutMs: number
  signal?: AbortSignal | undefined
}) {
  const { host, port, deviceId, clientId, username, password } = credentials
  // `#` is refused by the P1 Max; one level is granted. photonP1MaxSources.connection
  const reportPrefix = `${topicRoot}/printer/public/132/${deviceId}/`
  // The verified LAN publish origin is `web`. photonP1MaxSources.reads
  const commandPrefix = `${topicRoot}/web/printer/132/${deviceId}/`
  const readings = emptyPhotonResinReadings()
  const waiters = new Set<Waiter>()
  let connected = false
  let closed = false
  let controlling = false
  /** Set after an uncertain start or stop; blocks another start. */
  let unresolved: { filename: string; command: 'start' | 'stop' } | undefined
  let failure: string | undefined
  let failOpening: (reason: string) => void = () => {}

  const client = new MqttClient(
    () => {
      // Bound each MQTT packet before the library buffers it.
      let skip = 0
      let length = 0
      let multiplier = 1
      let header = true
      const socket = connectAnycubicTls(
        {
          host,
          port,
          minVersion: 'TLSv1.2',
          // The broker's certificate is RSA 1024 with SHA-1, so OpenSSL's
          // default security level rejects it. The exact pin supplies trust.
          // https://github.com/modrzew/hass-anycubic-photon-p1/blob/f33ceb5bc47388412a7a378ed58649736a5a6834/docs/protocol.md#tls-configuration
          ciphers: 'DEFAULT:@SECLEVEL=0',
        },
        pinSha256,
      )
      socket.prependListener('data', (chunk: Buffer) => {
        for (const byte of chunk) {
          if (skip > 0) skip--
          else if (header) {
            header = false
            length = 0
            multiplier = 1
          } else {
            length += (byte & 127) * multiplier
            if (length > packetLimit || multiplier > 2_097_152) {
              socket.destroy()
              return
            }
            if (byte & 128) multiplier *= 128
            else {
              skip = length
              header = true
            }
          }
        }
      })
      return socket
    },
    {
      manualConnect: true,
      protocolVersion: 4,
      // The P1 Max broker accepts only the issued ID, so one LAN client at a
      // time. Reconnecting would fight Photon Workshop; the caller reopens.
      clientId,
      username,
      password,
      connectTimeout: connectTimeoutMs,
      reconnectPeriod: 0,
      clean: true,
      resubscribe: false,
      queueQoSZero: false,
    },
  )

  function close() {
    if (closed) return
    closed = true
    connected = false
    // The stream lives only as long as the client that started it.
    readings.cameraStreaming = null
    signal?.removeEventListener('abort', close)
    client.end(true)
    for (const waiter of [...waiters]) waiter.finish(undefined)
    failOpening(failure ?? 'Photon LAN broker closed the session')
  }

  function snapshot(): PhotonResinState {
    return {
      ...structuredClone(readings),
      connected,
      camera:
        connected && readings.cameraStreaming
          ? {
              url: `http://${host.includes(':') ? `[${host}]` : host}:${cameraPort}/flv`,
              // The P1 Max picture arrives sideways. photonP1MaxSources.reads
              rotationDegrees: 270,
            }
          : null,
    }
  }

  function waitFor(
    match: Waiter['match'],
    timeoutMs: number,
  ): Promise<PhotonResinReport | undefined> {
    return new Promise((resolve) => {
      if (closed) return resolve(undefined)
      const waiter: Waiter = {
        match,
        finish(report) {
          clearTimeout(timer)
          waiters.delete(waiter)
          resolve(report)
        },
      }
      const timer = setTimeout(() => waiter.finish(undefined), timeoutMs)
      waiters.add(waiter)
    })
  }

  function send(type: string, action: string, data: Record<string, unknown>) {
    if (connected) {
      // A P1 Max ignores requests lacking timestamp and msgid.
      // photonP1MaxSources.connection
      client.publish(
        commandPrefix + type,
        JSON.stringify({
          type,
          action,
          timestamp: Date.now(),
          msgid: randomUUID(),
          data,
        }),
        { qos: 0 },
      )
    }
  }

  /** Registers the waiter first, so only a later report can answer. */
  function exchange(
    type: string,
    action: string,
    data: Record<string, unknown>,
    match: Waiter['match'],
  ) {
    const reply = waitFor(match, commandTimeoutMs)
    send(type, action, data)
    return reply
  }

  async function read(type: string, action: string) {
    // A fresh scratch reading proves that the reply itself was usable.
    const reply = await exchange(
      type,
      action,
      {},
      (report) =>
        report.type === type &&
        applyPhotonResinReport(emptyPhotonResinReadings(), report, 0),
    )
    return reply !== undefined
  }

  client.on('message', (topic, payload, packet) => {
    // A retained report could be old, so it cannot describe current state.
    if (
      closed ||
      packet.retain ||
      !topic.startsWith(reportPrefix) ||
      !/^[A-Za-z]+\/report$/.test(topic.slice(reportPrefix.length))
    )
      return
    const report = parsePhotonResinReport(payload)
    if (!report) return
    const applied = applyPhotonResinReport(readings, report, Date.now())
    const job = readings.job
    if (
      applied &&
      unresolved &&
      report.type === 'print' &&
      job?.filename === unresolved.filename &&
      (unresolved.command === 'stop'
        ? job.phase === 'stopped'
        : job.phase === 'printing' || job.phase === 'waiting')
    )
      unresolved = undefined
    for (const waiter of [...waiters])
      if (waiter.match(report)) waiter.finish(report)
  })

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(
      () => fail('Photon LAN broker session timed out'),
      connectTimeoutMs,
    )
    function fail(reason: string) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      close()
      reject(new Error(reason))
    }
    failOpening = fail
    client.on('error', (error: Error & { code?: string | number }) => {
      failure =
        error instanceof PinMismatch
          ? 'Photon LAN broker certificate does not match the pin'
          : error.code === 'ECONNREFUSED' || typeof error.code === 'number'
            ? 'Photon LAN broker refused the connection'
            : 'Photon LAN broker connection failed'
      close()
    })
    client.on('close', close)
    client.on('connect', () => {
      client.subscribe(
        `${reportPrefix}+/report`,
        { qos: 0 },
        (error, grants) => {
          if (settled) return
          if (
            error ||
            !grants?.length ||
            grants.some((grant) => grant.qos === 128)
          )
            return fail('Photon LAN broker refused the report subscription')
          connected = true
          // CONNACK alone proves nothing about the printer: require its status.
          void read('status', 'query').then((answered) => {
            if (settled) return
            if (!answered)
              return fail(
                'Photon LAN broker session returned no printer status',
              )
            settled = true
            clearTimeout(timer)
            resolve()
          })
        },
      )
    })
    signal?.addEventListener('abort', close, { once: true })
    if (signal?.aborted) close()
    else client.connect()
  })

  async function refresh() {
    // `print` is silent while idle, so it is sent without waiting.
    send('print', 'query', {})
    await Promise.all([
      read('status', 'query'),
      read('peripherie', 'query'),
      read('releaseFilm', 'get'),
    ])
    return snapshot()
  }

  function result(
    outcome: 'rejected' | 'refused' | 'uncertain',
    reason: string,
  ): PhotonResinCommandResult {
    return { outcome, reason, state: snapshot() }
  }

  function confirmed(): PhotonResinCommandResult {
    return { outcome: 'confirmed', state: snapshot() }
  }

  const silent = 'No printer report settled the command; it was not retried'

  async function control(
    operation: () => Promise<PhotonResinCommandResult>,
  ): Promise<PhotonResinCommandResult> {
    if (!connected) return result('refused', 'The LAN session is closed')
    if (controlling)
      return result('refused', 'Another printer command is in progress')
    controlling = true
    try {
      return await operation()
    } finally {
      controlling = false
    }
  }

  async function camera(
    action: 'startCapture' | 'stopCapture',
  ): Promise<PhotonResinCommandResult> {
    return control(async () => {
      if (action === 'startCapture' && !readings.peripherals?.camera)
        return result('refused', 'The printer has not reported a camera')
      const reply = await exchange(
        'video',
        action,
        {},
        (report) => report.type === 'video' && report.action === action,
      )
      if (!reply) return result('uncertain', silent)
      const applied =
        action === 'startCapture'
          ? reply.state === 'initSuccess' && reply.code === 200
          : photonCameraStopped(reply)
      return applied
        ? confirmed()
        : result('rejected', `The printer answered code ${reply.code}`)
    })
  }

  await refresh()
  if (!connected)
    throw new Error(failure ?? 'Photon LAN broker closed the session')

  return {
    state: snapshot,
    refresh,
    close,
    /** Only what this open session has seen the printer report. */
    capabilities(): PhotonResinCapability[] {
      if (!connected) return []
      const capabilities: PhotonResinCapability[] = ['status']
      const { job, peripherals } = readings
      if (job) capabilities.push('job-report')
      if (job && stoppable(job)) capabilities.push('print-stop')
      if (readings.resinTemperature) capabilities.push('resin-temperature')
      if (readings.releaseFilm) capabilities.push('release-film-counter')
      if (readings.localFiles) capabilities.push('local-file-list')
      if (peripherals) capabilities.push('peripherals')
      if (peripherals?.camera) capabilities.push('camera')
      if (peripherals?.usbDisk) capabilities.push('usb-print-start')
      return capabilities
    },
    // The printer stays silent without a path. photonP1MaxSources.reads
    listLocalFiles(): Promise<PhotonResinCommandResult> {
      return control(async () => {
        const reply = await exchange(
          'file',
          'listLocal',
          { path: '/' },
          (report) => report.type === 'file' && report.action === 'listLocal',
        )
        if (!reply) return result('uncertain', silent)
        return reply.code === 200 &&
          applyPhotonResinReport(emptyPhotonResinReadings(), reply, 0)
          ? confirmed()
          : result('rejected', `The printer answered code ${reply.code}`)
      })
    },
    startCamera: () => camera('startCapture'),
    stopCamera: () => camera('stopCapture'),
    /** Starts a file already at the root of the printer's USB stick. */
    startUsbPrint(filename: string): Promise<PhotonResinCommandResult> {
      return control(async () => {
        if (!/^[^/\\\u0000-\u001f\u007f]{1,128}\.pp1m$/i.test(filename))
          return result('refused', 'Expected a .pp1m file in the USB root')
        if (unresolved)
          return result('refused', 'An earlier print command is unresolved')
        if (!(await read('status', 'query')))
          return result('refused', 'The printer sent no fresh status')
        if (readings.printer?.activity !== 'free')
          return result('refused', 'The printer does not report free')
        if (readings.job && readings.job.phase !== 'stopped')
          return result('refused', 'A print job has not reported its stop')
        if (!(await read('peripherie', 'query')))
          return result('refused', 'The printer sent no fresh peripherals')
        if (!readings.peripherals?.usbDisk)
          return result('refused', 'The printer reports no USB stick')
        // Shape: photonP1MaxSources.commands and the library's
        // data_models/orders.py (AnycubicStartPrintRequestUdisk).
        const reply = await exchange(
          'print',
          'start',
          {
            taskid: '-1',
            filetype: 2,
            file_key: '',
            file_name: '',
            task_settings: { ai_detect: 0, camera_timelapse: 0 },
            filename,
            filepath: '/',
          },
          (report) =>
            report.type === 'print' &&
            report.action === 'start' &&
            (report.state === 'printing' || report.state === 'waiting') &&
            report.data?.filename === filename,
        )
        if (reply) return confirmed()
        unresolved = { filename, command: 'start' }
        return result('uncertain', silent)
      })
    },
    /**
     * Cancels the named job. The caller names the file it intends to stop.
     * `authorize` runs after every check, on the same stack as the publish.
     */
    stopPrint(
      filename: string,
      authorize?: () => boolean,
    ): Promise<PhotonResinCommandResult> {
      return control(async () => {
        if (!(await read('status', 'query')))
          return result('refused', 'The printer sent no fresh status')
        const job = readings.job
        if (!job || !stoppable(job))
          return result('refused', 'The printer reports no stoppable job')
        if (job.filename !== filename)
          return result('refused', 'The printer reports a different job')
        const taskId = job.taskId
        if (!connected) return result('refused', 'The LAN session is closed')
        if (authorize && !authorize())
          return result('refused', 'Command authority was withdrawn')
        const reply = await exchange(
          'print',
          'stop',
          { taskid: taskId },
          (report) =>
            report.type === 'print' &&
            report.action === 'stop' &&
            report.state === 'stoped' &&
            report.data?.taskid === taskId &&
            report.data?.filename === filename,
        )
        if (reply) return confirmed()
        unresolved = { filename, command: 'stop' }
        return result('uncertain', silent)
      })
    },
    pausePrint: async () => result('refused', photonResinRefusals.pause),
    resumePrint: async () => result('refused', photonResinRefusals.resume),
    uploadFile: async () => result('refused', photonResinRefusals.upload),
    measuredResinUsage: () => ({
      measuredVolumeMl: null,
      reason: photonResinRefusals.resinMetering,
    }),
  }
}

function stoppable(job: NonNullable<PhotonResinReadings['job']>) {
  return (
    (job.phase === 'printing' || job.phase === 'waiting') &&
    job.filename !== null &&
    job.taskId !== null &&
    job.taskId !== '-1'
  )
}

export type PhotonResinSession = Awaited<
  ReturnType<typeof openPhotonResinBrokerSession>
>
