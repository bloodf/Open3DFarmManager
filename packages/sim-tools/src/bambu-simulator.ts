// SPDX-License-Identifier: MIT
import {
  encodePacket,
  startMqttBroker,
  type MqttMockInstance,
} from './mocks/mqtt-broker.ts'
import { ScenarioController, type ScenarioStep } from './mocks/scenario.ts'
import type { ThrowawayTlsMaterial } from './mocks/tls.ts'
import { startBambuFtpsSim } from './bambu-ftps-sim.ts'

export { encodePacket as packet }

export interface BambuSimulatorState {
  gcodeState?: string | undefined
  extended: Record<string, unknown>
}

export interface BambuSimulatorOptions {
  printDurationMs?: number | undefined
  totalLayers?: number | undefined
  serial?: string | undefined
  accessCode?: string | undefined
  /** Listen address; loopback unless explicitly opted in (Docker sandbox). */
  host?: string | undefined
  port?: number | undefined
  ftpsPort?: number | undefined
  initialState?: 'RUNNING' | 'PAUSE' | 'IDLE' | undefined
  initialTargetTemperature?: number | undefined
  /** Layer of a print already in progress (RUNNING or PAUSE) at start-up. */
  initialLayer?: number | undefined
  /** Reported as `nozzle_diameter`; absent unless given. */
  nozzleDiameter?: string | undefined
  versionModules?: { name: string; sw_ver: string }[] | undefined
  confirmCommands?: boolean | undefined
  /**
   * Interval of the repeated status report (default 100 ms). State changes and
   * command replies are always reported at once; this only sets how often an
   * unchanged state is repeated.
   */
  reportIntervalMs?: number | undefined
  credentials?:
    { username?: string | undefined; password?: string | undefined } | undefined
  tls?:
    | (
        | { key: Buffer; cert: Buffer; ca?: Buffer | undefined }
        | ThrowawayTlsMaterial
      )
    | undefined
  reuseSharedTls?: boolean | undefined
  scenario?: ScenarioStep<BambuSimulatorState>[] | undefined
}

export async function startBambuSimulator({
  serial = 'SYNTHETIC',
  accessCode = 'secret',
  host = '127.0.0.1',
  port = 0,
  ftpsPort = 0,
  initialState,
  initialTargetTemperature,
  initialLayer,
  nozzleDiameter,
  confirmCommands = true,
  reportIntervalMs = 100,
  versionModules,
  printDurationMs,
  totalLayers = 100,
  credentials,
  tls,
  reuseSharedTls = true,
  scenario: scenarioSteps,
}: BambuSimulatorOptions = {}) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(serial))
    throw new Error('Invalid synthetic serial')
  if (!accessCode || /[\r\n]/.test(accessCode))
    throw new Error('Invalid synthetic access code')
  if (
    printDurationMs !== undefined &&
    (!Number.isFinite(printDurationMs) ||
      printDurationMs <= 0 ||
      !Number.isInteger(totalLayers) ||
      totalLayers < 1)
  )
    throw new Error('Invalid print configuration')
  if (
    !Number.isInteger(reportIntervalMs) ||
    reportIntervalMs < 5 ||
    reportIntervalMs > 60_000
  )
    throw new Error('Invalid report interval')

  if (
    initialLayer !== undefined &&
    (initialState === undefined ||
      initialState === 'IDLE' ||
      !Number.isInteger(initialLayer) ||
      initialLayer < 0 ||
      initialLayer > totalLayers)
  )
    throw new Error('Invalid initial layer')

  const uploads = new Map<string, Buffer>()
  const timelapse = new Map<string, Buffer>()
  /** Every accepted `gcode_line` script, in arrival order. */
  const gcodeLines: string[] = []
  let timer: ReturnType<typeof setInterval> | undefined
  // Only an uploaded print advances on its own; resume keeps that mode.
  let timed = false
  let elapsed = 0
  let lastTick = 0
  const reportTopic = `device/${serial}/report`
  const requestTopic = `device/${serial}/request`
  let gcodeState: string | undefined = initialState
  const extended: Record<string, unknown> = {
    nozzle_temper: 210,
    bed_temper: 60,
    ams: {
      ams: [
        {
          id: 0,
          tray: [
            { id: 0, tray_type: 'PLA', tray_color: 'FFFFFFFF', remain: 100 },
          ],
        },
      ],
    },
    ...(initialTargetTemperature === undefined
      ? {}
      : { nozzle_target_temper: initialTargetTemperature }),
    ...(initialLayer === undefined
      ? {}
      : { layer_num: initialLayer, total_layer_num: totalLayers }),
    ...(nozzleDiameter === undefined
      ? {}
      : { nozzle_diameter: nozzleDiameter }),
  }
  // Commands that act on the printer (pause, resume, stop, gcode, ...), in arrival order.
  const requests: {
    command: string
    sequence_id: string
    ams_mapping?: unknown
    use_ams?: unknown
  }[] = []
  // Read-only queries (pushall and get_version). Kept apart from `requests`: the connector's telemetry
  // transport asks for the version as soon as it subscribes, concurrently with the first report,
  // so mixing it into `requests` makes "no command was sent" checks depend on socket timing.
  const queries: { command: string; sequence_id: string }[] = []

  let brokerRef: MqttMockInstance | undefined
  let closed = false

  function currentReportPayload() {
    return {
      print: { gcode_state: gcodeState, mc_percent: 25, ...extended },
    }
  }

  function hasSubscribers(): boolean {
    if (!brokerRef) return false
    for (const topics of brokerRef.control.subscriptions.values()) {
      if (topics.size > 0) return true
    }
    return false
  }

  function emitCurrentReport() {
    brokerRef?.control.publish(reportTopic, currentReportPayload())
  }

  function stopTimer() {
    if (timer) clearInterval(timer)
    timer = undefined
  }

  function startTimer() {
    if (printDurationMs === undefined) return
    stopTimer()
    lastTick = Date.now()
    timer = setInterval(
      () => {
        const now = Date.now()
        elapsed += now - lastTick
        lastTick = now
        const fraction = Math.min(elapsed / printDurationMs, 1)
        extended.mc_percent = Math.floor(fraction * 100)
        extended.layer_num = Math.floor(fraction * totalLayers)
        extended.total_layer_num = totalLayers
        if (fraction === 1) {
          gcodeState = 'FINISH'
          timed = false
          stopTimer()
        }
        emitCurrentReport()
      },
      Math.min(100, Math.max(5, printDurationMs / 10)),
    )
  }

  const broker = await startMqttBroker({
    host,
    port,
    handshakeTimeout: 3000,
    socketTimeout: 10000,
    strictConnect: true,
    tls,
    reuseSharedTls: tls ? false : reuseSharedTls,
    auth: credentials,
    authorizeSubscribe: (topic) => topic === reportTopic,
    onSubscribe: () => {
      if (gcodeState) emitCurrentReport()
    },
    onPublish: async (msg) => {
      if (msg.topic !== requestTopic) throw new Error('Invalid request topic')
      const value = JSON.parse(msg.payload.toString('utf8'))
      if (value?.pushing?.command === 'pushall') {
        queries.push({
          command: 'pushall',
          sequence_id: value.pushing.sequence_id,
        })
        emitCurrentReport()
        return
      }
      if (value?.info?.command === 'get_version') {
        queries.push({
          command: 'get_version',
          sequence_id: value.info.sequence_id,
        })
        if (versionModules) {
          broker.control.publish(reportTopic, {
            info: {
              command: 'get_version',
              module: versionModules,
            },
          })
        }
        return
      }
      const request = value?.print ?? value?.system
      const command = request?.command
      if (
        ![
          'pause',
          'resume',
          'stop',
          'gcode_line',
          'ledctrl',
          'print_speed',
          'project_file',
          'ams_change_filament',
        ].includes(command) ||
        typeof request?.sequence_id !== 'string'
      )
        throw new Error('Invalid request')
      requests.push({
        command,
        sequence_id: request.sequence_id,
        ...(request.ams_mapping !== undefined
          ? { ams_mapping: request.ams_mapping }
          : {}),
        ...(request.use_ams !== undefined ? { use_ams: request.use_ams } : {}),
      })
      if (!confirmCommands) return

      if (command === 'gcode_line') {
        const match = /^(M104|M140|M106 P[123]) S(\d+)\n$/.exec(request.param)
        const home = /^G28 ([XYZ](?: [XYZ])*)\n$/.exec(request.param)
        if (!match && !home && !validScript(request.param))
          throw new Error('Invalid gcode')
      } else if (
        command === 'ledctrl' &&
        request.led_node === 'chamber_light' &&
        ['on', 'off'].includes(request.led_mode)
      ) {
        // valid
      } else if (command === 'print_speed' && /^[1-4]$/.test(request.param)) {
        // valid
      } else if (
        command === 'project_file' &&
        request.param === 'Metadata/plate_1.gcode' &&
        typeof request.url === 'string' &&
        request.url.startsWith('file:///sdcard/')
      ) {
        if (
          printDurationMs !== undefined &&
          !uploads.has(sdcardFileName(request.url))
        )
          throw new Error('File not uploaded')
      } else if (
        command === 'ams_change_filament' &&
        Number.isInteger(request.target) &&
        ((request.target >= 0 && request.target <= 15) ||
          request.target === 255) &&
        Number.isInteger(request.curr_temp) &&
        request.curr_temp >= 0 &&
        request.curr_temp <= 300 &&
        Number.isInteger(request.tar_temp) &&
        request.tar_temp >= 0 &&
        request.tar_temp <= 300
      ) {
        // valid
      } else if (!['pause', 'resume', 'stop'].includes(command))
        throw new Error('Invalid request')

      const ackFault = broker.control.faults.matchFault({
        topic: msg.topic,
        method: 'ACK',
      })
      if (ackFault) {
        if (ackFault.type === 'drop') {
          await broker.control.disconnectClients()
          return
        }
        if (ackFault.type === 'refuse' || ackFault.type === 'stall') {
          return
        }
        if (ackFault.type === 'malformed') {
          broker.control.publish(reportTopic, ackFault.payload ?? '{malformed')
          return
        }
        if (ackFault.type === 'delay') {
          await new Promise((r) => setTimeout(r, ackFault.delayMs))
          if (closed) return
        }
      }

      if (command === 'gcode_line') {
        const match = /^(M104|M140|M106 P[123]) S(\d+)\n$/.exec(request.param)
        const home = /^G28 ([XYZ](?: [XYZ])*)\n$/.exec(request.param)
        if (match) extended[match[1]!] = Number(match[2])
        else if (home) extended.homed_axes = home[1]
        gcodeLines.push(request.param)
      } else if (command === 'ledctrl') {
        extended.light = request.led_mode
      } else if (command === 'print_speed') {
        extended.speed = request.param
      } else if (command === 'project_file') {
        extended.file = request.url
        const fileName = sdcardFileName(request.url)
        extended.subtask_name = fileName
        extended.gcode_file = fileName
        gcodeState = 'RUNNING'
        elapsed = 0
        extended.mc_percent = 0
        if (printDurationMs !== undefined) {
          extended.layer_num = 0
          extended.total_layer_num = totalLayers
          timed = true
          startTimer()
        } else delete extended.mc_percent
      } else if (command === 'ams_change_filament') {
        extended.ams = { tray_now: String(request.target) }
      }

      if (['pause', 'resume', 'stop'].includes(command))
        gcodeState =
          command === 'pause'
            ? 'PAUSE'
            : command === 'resume'
              ? 'RUNNING'
              : 'IDLE'
      if (command === 'stop') timed = false
      if (command === 'pause' || command === 'stop') stopTimer()
      if (command === 'resume' && timed) startTimer()

      emitCurrentReport()
    },
  })
  brokerRef = broker

  const scenario = new ScenarioController<BambuSimulatorState>({
    steps: scenarioSteps,
    applyState: (patch) => {
      if ('gcodeState' in patch) gcodeState = patch.gcodeState
      if (patch.extended) Object.assign(extended, patch.extended)
    },
    publishReport: (value) => {
      broker.control.publish(reportTopic, value)
    },
    getState: () => ({ gcodeState, extended: { ...extended } }),
  })

  const periodicReports = setInterval(() => {
    if (gcodeState && hasSubscribers()) emitCurrentReport()
  }, reportIntervalMs)

  const tlsMaterial = broker.control.tlsMaterial
  const syntheticTrust = tlsMaterial
    ? `${tlsMaterial.server.cert.toString('utf8')}\n${tlsMaterial.ca.cert.toString('utf8')}`
    : tls && !('server' in tls)
      ? `${tls.cert.toString('utf8')}${tls.ca ? `\n${tls.ca.toString('utf8')}` : ''}`
      : ''

  const ftpsIdentity = tlsMaterial
    ? tlsMaterial.server
    : tls && !('server' in tls)
      ? tls
      : tls?.server
  if (!ftpsIdentity) throw new Error('Missing simulator TLS identity')
  let ftps: Awaited<ReturnType<typeof startBambuFtpsSim>>
  try {
    ftps = await startBambuFtpsSim({
      host,
      port: ftpsPort,
      accessCode,
      key: ftpsIdentity.key,
      cert: ftpsIdentity.cert,
      uploads,
      timelapse,
    })
  } catch (error) {
    clearInterval(periodicReports)
    scenario.stop()
    await broker.close()
    throw error
  }

  function publishReport(value: unknown) {
    broker.control.publish(reportTopic, value)
  }

  function disconnectClients() {
    return broker.control.disconnectClients()
  }

  let closing: Promise<void> | undefined

  return {
    host,
    port: broker.ports.default,
    ftpsPort: ftps.port,
    ftpsListingRequests: ftps.listingRequests,
    origin: broker.origin,
    ports: broker.ports,
    syntheticTrust,
    reportTopic,
    requests,
    queries,
    uploads,
    timelapse,
    gcodeLines,
    calls: broker.calls,
    control: {
      setFtpsMlsdRejection: ftps.setMlsdRejection,
      faults: broker.control.faults,
      scenario,
      publish: broker.control.publish,
      publishReport,
      setAlarmReport(delta: {
        print_error?: number
        hms?: { attr: number; code: number }[]
      }) {
        Object.assign(extended, delta)
        publishReport({ print: { ...delta, command: 'push_status' } })
      },
      disconnectClients,
      subscriptions: broker.control.subscriptions,
      sockets: broker.control.sockets,
      tlsMaterial: broker.control.tlsMaterial,
    },
    get extendedState() {
      return { ...extended }
    },
    get gcodeState() {
      return gcodeState
    },
    publishReport,
    uploadTimelapse(name: string, data: Uint8Array) {
      if (!/^[A-Za-z0-9_.-]+$/.test(name) || name === '..' || !data.length)
        throw new Error('Invalid upload')
      timelapse.set(name, Buffer.from(data))
    },
    uploadFile(name: string, data: Uint8Array) {
      if (!/^[A-Za-z0-9_.-]+$/.test(name) || name === '..' || !data.length)
        throw new Error('Invalid upload')
      uploads.set(name, Buffer.from(data))
    },
    /** Journey control: a print in progress at a fixed percentage. */
    setPrintProgress(percent: number) {
      if (!Number.isInteger(percent) || percent < 0 || percent > 99)
        throw new Error('Invalid progress')
      timed = false
      stopTimer()
      gcodeState = 'RUNNING'
      extended.mc_percent = percent
      emitCurrentReport()
    },
    /** Journey control: the running print completes. */
    finishPrint() {
      if (gcodeState !== 'RUNNING' && gcodeState !== 'PAUSE')
        throw new Error('No active print')
      timed = false
      stopTimer()
      gcodeState = 'FINISH'
      extended.mc_percent = 100
      emitCurrentReport()
    },
    failPrint() {
      if (gcodeState !== 'RUNNING' && gcodeState !== 'PAUSE')
        throw new Error('No active print')
      timed = false
      stopTimer()
      gcodeState = 'FAILED'
      emitCurrentReport()
    },
    disconnectClients,
    close() {
      closed = true
      stopTimer()
      clearInterval(periodicReports)
      scenario.stop()
      closing ??= (async () => {
        await ftps.close()
        await broker.close()
      })()
      return closing
    },
  }
}

/** Plain motion and console scripts: one G or M command per line. */
function validScript(param: unknown) {
  return (
    typeof param === 'string' &&
    param.endsWith('\n') &&
    param
      .slice(0, -1)
      .split('\n')
      .every((line) => /^[GM]\d{1,3}(?: [A-Z]-?\d+(?:\.\d+)?)*$/.test(line))
  )
}

function sdcardFileName(url: string) {
  return decodeURIComponent(url.slice('file:///sdcard/'.length))
}
