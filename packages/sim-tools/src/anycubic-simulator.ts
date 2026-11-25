// SPDX-License-Identifier: MIT
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import {
  encodePacket,
  startMqttBroker,
  type MqttMockInstance,
} from './mocks/mqtt-broker.ts'
import { ScenarioController, type ScenarioStep } from './mocks/scenario.ts'
import type { ThrowawayTlsMaterial } from './mocks/tls.ts'

export { encodePacket as packet }

export interface AnycubicSimulatorState {
  lifecycle: 'idle' | 'printing' | 'paused' | 'finished' | 'error'
  progress: number
  gcodeState?: string | undefined
  extended: Record<string, unknown>
}

export interface AnycubicSimulatorOptions {
  serial?: string | undefined
  port?: number | undefined
  /** `listReply` and `uploadCode` model refusals; see the `file/report` below. */
  lanFiles?:
    | {
        firmware: string
        listReply?: { state: string; code: number } | undefined
        uploadCode?: number | undefined
      }
    | undefined
  initialState?: 'RUNNING' | 'PAUSE' | 'IDLE' | undefined
  credentials?: { username: string; password: string } | undefined
  confirmCommands?: boolean | undefined
  environmentReport?: unknown
  printDurationMs?: number | undefined
  totalLayers?: number | undefined
  /** Period of the repeated report each subscribed client receives. */
  reportIntervalMs?: number | undefined
  tls?:
    | (
        | { key: Buffer; cert: Buffer; ca?: Buffer | undefined }
        | ThrowawayTlsMaterial
      )
    | undefined
  reuseSharedTls?: boolean | undefined
  scenario?: ScenarioStep<AnycubicSimulatorState>[] | undefined
}

export async function startAnycubicSimulator({
  serial = 'SYNTHETIC',
  port = 0,
  lanFiles,
  initialState,
  confirmCommands = true,
  credentials,
  environmentReport,
  printDurationMs = 1000,
  totalLayers = 10,
  reportIntervalMs = 100,
  tls,
  reuseSharedTls = true,
  scenario: scenarioSteps,
}: AnycubicSimulatorOptions = {}) {
  if (!/^[A-Za-z0-9_/-]{1,128}$/.test(serial))
    throw new Error('Invalid synthetic serial')
  if (
    !Number.isFinite(printDurationMs) ||
    printDurationMs <= 0 ||
    !Number.isInteger(totalLayers) ||
    totalLayers <= 0
  )
    throw new Error('Invalid print configuration')
  if (!Number.isInteger(reportIntervalMs) || reportIntervalMs < 10)
    throw new Error('Invalid report interval')

  const files = new Map<string, Buffer>()
  let lifecycle: 'idle' | 'printing' | 'paused' | 'finished' | 'error' = 'idle'
  let elapsed = 0
  let started = 0
  let timer: ReturnType<typeof setInterval> | undefined
  let progress = 0
  // A progress set by the journey controls has no clock to resume from.
  let scripted = false
  let filename: string | undefined
  let remainingMinutes: number | undefined
  // Targets and switches set by the documented `update` and `light` requests.
  const settings: Record<string, number> = {}
  let light: { type: number; status: number } | undefined
  const reportTopic = `anycubic/anycubicCloud/v1/printer/public/${serial}/info/report`
  const wildcardReportTopic = reportTopic.replace('/info/report', '/+/report')
  let gcodeState: string | undefined = initialState
  const extended: Record<string, unknown> = {}
  const requests: { command: string; sequence_id: string }[] = []

  let uploadPort: number | undefined
  const uploadToken = randomUUID()
  let uploads = 0
  const slicerTopic = `anycubic/anycubicCloud/v1/slicer/printer/${serial}`

  let brokerRef: MqttMockInstance | undefined
  let closed = false

  function currentReportPayload() {
    const layer = Math.floor((progress * totalLayers) / 100)
    const job = {
      progress,
      curr_layer: layer,
      total_layers: totalLayers,
      ...(filename ? { filename } : {}),
    }
    const active = lifecycle === 'printing' || lifecycle === 'paused'
    return {
      print: { gcode_state: gcodeState, mc_percent: 25, ...extended },
      data: {
        ...(remainingMinutes !== undefined && active
          ? {
              state: 'busy',
              project: {
                ...job,
                state: 'printing',
                pause: lifecycle === 'paused' ? 1 : 0,
                remain_time: remainingMinutes,
              },
            }
          : { state: lifecycle, ...job }),
        // Made up: the simulated heaters reach a target at once.
        ...(settings.target_nozzle_temp !== undefined
          ? { target_nozzle_temp: settings.target_nozzle_temp }
          : {}),
        ...(settings.target_hotbed_temp !== undefined
          ? { target_hotbed_temp: settings.target_hotbed_temp }
          : {}),
        ...(settings.target_nozzle_temp !== undefined
          ? { curr_nozzle_temp: settings.target_nozzle_temp }
          : {}),
        ...(settings.target_hotbed_temp !== undefined
          ? { curr_hotbed_temp: settings.target_hotbed_temp }
          : {}),
        ...(settings.fan_speed_pct !== undefined
          ? { fan_speed_pct: settings.fan_speed_pct }
          : {}),
        ...(light ? { lights: [light] } : {}),
      },
    }
  }

  function hasSubscribers(): boolean {
    if (!brokerRef) return false
    for (const topics of brokerRef.control.subscriptions.values()) {
      if (topics.size > 0) return true
    }
    return false
  }

  function broadcast() {
    brokerRef?.control.publish(reportTopic, currentReportPayload())
  }

  function stopTimer() {
    if (timer) clearInterval(timer)
    timer = undefined
  }

  function startTimer() {
    started = Date.now()
    timer = setInterval(
      () => {
        progress = Math.min(
          100,
          Math.floor(
            ((elapsed + Date.now() - started) * 100) / printDurationMs,
          ),
        )
        if (progress === 100) {
          lifecycle = 'finished'
          stopTimer()
        }
        broadcast()
      },
      Math.min(50, printDurationMs),
    )
  }

  async function emitCommandAck(topic: string, applyUpdate: () => void) {
    const ackFault = brokerRef?.control.faults.matchFault({
      topic,
      method: 'ACK',
    })
    if (ackFault) {
      if (ackFault.type === 'drop') {
        await brokerRef?.control.disconnectClients()
        return
      }
      if (ackFault.type === 'refuse' || ackFault.type === 'stall') {
        return
      }
      if (ackFault.type === 'malformed') {
        brokerRef?.control.publish(
          reportTopic,
          ackFault.payload ?? '{malformed',
        )
        return
      }
      if (ackFault.type === 'delay') {
        await new Promise((r) => setTimeout(r, ackFault.delayMs))
        if (closed) return
      }
    }
    applyUpdate()
    broadcast()
  }

  const broker = await startMqttBroker({
    port,
    handshakeTimeout: 3000,
    socketTimeout: 10000,
    strictConnect: true,
    tls,
    reuseSharedTls: tls ? false : reuseSharedTls,
    auth: credentials,
    authorizeSubscribe: (topic) =>
      topic === reportTopic || topic === wildcardReportTopic,
    onSubscribe: () => {
      if (gcodeState) broadcast()
      if (environmentReport !== undefined) {
        broker.control.publish(reportTopic, environmentReport)
      }
    },
    onPublish: async (msg) => {
      const topicName = msg.topic
      const raw = JSON.parse(msg.payload.toString('utf8'))
      if (lanFiles && typeof raw?.msgid === 'string') {
        if (
          topicName === slicerTopic + '/info' &&
          raw.type === 'info' &&
          raw.action === 'query' &&
          raw.data === null
        ) {
          broker.control.publish(reportTopic, {
            type: 'info',
            action: 'report',
            msgid: raw.msgid,
            code: 200,
            state: 'done',
            data: {
              version: lanFiles.firmware,
              state:
                lifecycle === 'idle' || lifecycle === 'finished'
                  ? 'free'
                  : 'busy',
              project: null,
              urls: {
                fileUploadurl: `http://127.0.0.1:${uploadPort}/gcode_upload?s=${uploadToken}`,
              },
            },
          })
          return
        }
        if (
          topicName === slicerTopic + '/file' &&
          raw.type === 'file' &&
          raw.action === 'listLocal' &&
          raw.data?.page_num === 1 &&
          raw.data?.page_size === 200 &&
          raw.data?.path === '/'
        ) {
          // Reference-derived, never captured:
          // bloodf/kobracontrol@c414db4f36d4c96f2b232c368ad6cfe56e3d0408
          // docs/protocol.md "Files on the printer" (request fields,
          // millisecond timestamps, the built-in `test_model` directory).
          broker.control.publish(reportTopic.replace('/info/', '/file/'), {
            type: 'file',
            action: 'listLocal',
            msgid: raw.msgid,
            ...(lanFiles.listReply ?? { state: 'done', code: 200 }),
            data: {
              list_mode: 0,
              records: [
                {
                  filename: 'test_model',
                  size: 0,
                  timestamp: Date.now(),
                  is_dir: true,
                },
                ...[...files].map(([filename, bytes]) => ({
                  filename,
                  size: bytes.length,
                  timestamp: Date.now(),
                  is_dir: false,
                })),
              ],
            },
          })
          return
        }
      }
      const isStart =
        [
          `anycubic/anycubicCloud/v1/slicer/printer/20024/${serial}/print`,
          // A serial that already carries the model id.
          `anycubic/anycubicCloud/v1/slicer/printer/${serial}/print`,
        ].includes(topicName) &&
        raw?.type === 'print' &&
        raw?.action === 'start'
      const isControl =
        topicName ===
          `anycubic/anycubicCloud/v1/printer/public/${serial}/print/request` &&
        raw?.type === 'print' &&
        ['stop', 'pause', 'resume'].includes(raw?.action)
      const isUpdate =
        topicName ===
          `anycubic/anycubicCloud/v1/printer/public/${serial}/print/request` &&
        raw?.type === 'print' &&
        raw?.action === 'update'
      const isLight =
        topicName ===
          `anycubic/anycubicCloud/v1/printer/public/${serial}/light/request` &&
        raw?.type === 'light' &&
        raw?.action === 'control'

      if (isUpdate || isLight) {
        if (!confirmCommands) return
        if (isLight) {
          const { type, status } = raw?.data ?? {}
          if (!Number.isInteger(type) || (status !== 0 && status !== 1))
            throw new Error('Invalid light request')
          await emitCommandAck(topicName, () => {
            light = { type, status }
          })
        } else {
          const entries = Object.entries(raw?.data?.settings ?? {})
          if (
            entries.length !== 1 ||
            entries.some(
              ([key, value]) =>
                ![
                  'target_nozzle_temp',
                  'target_hotbed_temp',
                  'fan_speed_pct',
                ].includes(key) ||
                !Number.isInteger(value) ||
                (value as number) < 0 ||
                (value as number) > 300,
            )
          )
            throw new Error('Invalid update request')
          await emitCommandAck(topicName, () => {
            for (const [key, value] of entries) settings[key] = value as number
          })
        }
        return
      }

      if (isStart || isControl) {
        if (!confirmCommands) return
        if (isStart) {
          if (
            !files.has(raw?.data?.filename) ||
            lifecycle === 'printing' ||
            lifecycle === 'paused'
          )
            throw new Error('Invalid start')
        }
        await emitCommandAck(topicName, () => {
          if (isStart) {
            stopTimer()
            elapsed = 0
            progress = 0
            remainingMinutes = undefined
            scripted = false
            filename = raw.data.filename
            lifecycle = 'printing'
            startTimer()
          } else if (
            raw.action === 'stop' &&
            (lifecycle === 'printing' || lifecycle === 'paused')
          ) {
            stopTimer()
            lifecycle = 'idle'
          } else if (raw.action === 'pause' && lifecycle === 'printing') {
            if (!scripted) elapsed += Date.now() - started
            stopTimer()
            lifecycle = 'paused'
          } else if (raw.action === 'resume' && lifecycle === 'paused') {
            lifecycle = 'printing'
            if (!scripted) startTimer()
          }
        })
        return
      }

      if (topicName !== `device/${serial}/request`)
        throw new Error('Invalid request topic')
      const request = raw?.print ?? raw?.system
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
        ].includes(command) ||
        typeof request?.sequence_id !== 'string'
      )
        throw new Error('Invalid request')
      requests.push({ command, sequence_id: request.sequence_id })
      if (!confirmCommands) return

      if (command === 'gcode_line') {
        const match = /^(M104|M140|M106 P[123]) S(\d+)\n$/.exec(request.param)
        const home = /^G28 ([XYZ](?: [XYZ])*)\n$/.exec(request.param)
        if (!match && !home) throw new Error('Invalid gcode')
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
        // valid
      } else if (!['pause', 'resume', 'stop'].includes(command))
        throw new Error('Invalid request')

      await emitCommandAck(topicName, () => {
        if (command === 'gcode_line') {
          const match = /^(M104|M140|M106 P[123]) S(\d+)\n$/.exec(request.param)
          const home = /^G28 ([XYZ](?: [XYZ])*)\n$/.exec(request.param)
          if (match) extended[match[1]!] = Number(match[2])
          else if (home) extended.homed_axes = home[1]
        } else if (command === 'ledctrl') {
          extended.light = request.led_mode
        } else if (command === 'print_speed') {
          extended.speed = request.param
        } else if (command === 'project_file') {
          extended.file = request.url
          gcodeState = 'RUNNING'
        } else if (['pause', 'resume', 'stop'].includes(command)) {
          gcodeState =
            command === 'pause'
              ? 'PAUSE'
              : command === 'resume'
                ? 'RUNNING'
                : 'IDLE'
        }
      })
    },
  })
  brokerRef = broker

  const scenario = new ScenarioController<AnycubicSimulatorState>({
    steps: scenarioSteps,
    applyState: (patch) => {
      if (patch.lifecycle) lifecycle = patch.lifecycle
      if (patch.progress !== undefined) progress = patch.progress
      if ('gcodeState' in patch) gcodeState = patch.gcodeState
      if (patch.extended) Object.assign(extended, patch.extended)
    },
    publishReport: (value) => {
      broker.control.publish(reportTopic, value)
    },
    getState: () => ({
      lifecycle,
      progress,
      gcodeState,
      extended: { ...extended },
    }),
  })

  const http = lanFiles
    ? createServer((request, response) => {
        if (
          request.method !== 'POST' ||
          request.url !== `/gcode_upload?s=${uploadToken}` ||
          (lifecycle !== 'idle' && lifecycle !== 'finished')
        ) {
          response.writeHead(403).end()
          return
        }
        void (async () => {
          const chunks: Buffer[] = []
          let total = 0
          for await (const value of request) {
            const chunk = Buffer.from(value)
            total += chunk.length
            if (total > 1024 * 1024) throw Error('Oversized synthetic upload')
            chunks.push(chunk)
          }
          const form = await new Response(Buffer.concat(chunks), {
            headers: { 'Content-Type': request.headers['content-type'] ?? '' },
          }).formData()
          const name = form.get('filename')
          const gcode = form.get('gcode')
          // Part order and answer: kobracontrol@c414db4f src/kobracontrol/kobra.py `_upload`.
          if (
            [...form.keys()].join() !== 'filename,gcode' ||
            typeof name !== 'string' ||
            !/^[a-zA-Z0-9 _.-]+\.gcode\.3mf$/i.test(name) ||
            !(gcode instanceof File) ||
            gcode.name !== name ||
            gcode.type !== 'application/octet-stream' ||
            !gcode.size ||
            request.headers['x-file-length'] !== String(gcode.size)
          )
            throw Error('Invalid synthetic multipart upload')
          const code = lanFiles.uploadCode ?? 200
          if (code === 200) {
            uploads++
            files.set(name, Buffer.from(await gcode.arrayBuffer()))
          }
          response.writeHead(200, { 'Content-Type': 'application/json' })
          response.end(
            JSON.stringify(
              code === 200
                ? { code, data: { gcode: name }, message: 'success' }
                : { code, message: 'synthetic refusal' },
            ),
          )
        })().catch(() => response.writeHead(400).end())
      })
    : undefined
  if (http) {
    try {
      uploadPort = await new Promise<number>((resolve, reject) => {
        http.once('error', reject)
        http.listen(0, '127.0.0.1', () => {
          const address = http.address()
          if (address && typeof address !== 'string') resolve(address.port)
          else reject(Error('Synthetic upload listener unavailable'))
        })
      })
    } catch (error) {
      await broker.close()
      throw error
    }
  }

  const periodicReports = setInterval(() => {
    if (gcodeState && hasSubscribers()) broadcast()
  }, reportIntervalMs)

  const tlsMaterial = broker.control.tlsMaterial
  const syntheticTrust = tlsMaterial
    ? `${tlsMaterial.server.cert.toString('utf8')}\n${tlsMaterial.ca.cert.toString('utf8')}`
    : tls && !('server' in tls)
      ? `${tls.cert.toString('utf8')}${tls.ca ? `\n${tls.ca.toString('utf8')}` : ''}`
      : ''

  function publishReport(value: unknown) {
    broker.control.publish(reportTopic, value)
  }

  function disconnectClients() {
    return broker.control.disconnectClients()
  }

  let closing: Promise<void> | undefined

  return {
    host: '127.0.0.1',
    port: broker.ports.default,
    origin: broker.origin,
    ports: broker.ports,
    syntheticTrust,
    reportTopic,
    requests,
    uploadPort,
    get uploadCount() {
      return uploads
    },
    calls: broker.calls,
    control: {
      faults: broker.control.faults,
      scenario,
      publish: broker.control.publish,
      publishReport,
      disconnectClients,
      subscriptions: broker.control.subscriptions,
      sockets: broker.control.sockets,
      tlsMaterial: broker.control.tlsMaterial,
    },
    upload(filenameInput: string, data: Buffer) {
      if (
        !filenameInput.endsWith('.gcode') ||
        filenameInput.length > 255 ||
        /[\\\x00-\x1f\x7f%]/.test(filenameInput) ||
        filenameInput
          .split('/')
          .some((part) => !part || part === '.' || part === '..') ||
        !Buffer.isBuffer(data) ||
        !data.length
      )
        throw new Error('Invalid synthetic upload')
      files.set(filenameInput, Buffer.from(data))
    },
    /** Journey control: a print in progress at a fixed percentage. */
    setPrintProgress(percent: number) {
      if (!Number.isInteger(percent) || percent < 0 || percent > 99)
        throw new Error('Invalid progress')
      stopTimer()
      scripted = true
      lifecycle = 'printing'
      progress = percent
      broadcast()
    },
    /** Journey control: the running print completes. */
    finishPrint() {
      if (lifecycle !== 'printing' && lifecycle !== 'paused')
        throw new Error('No active print')
      stopTimer()
      lifecycle = 'finished'
      progress = 100
      broadcast()
    },
    failPrint() {
      if (lifecycle !== 'printing' && lifecycle !== 'paused')
        throw new Error('No active print')
      stopTimer()
      lifecycle = 'error'
      broadcast()
    },
    get lifecycle() {
      return {
        state: lifecycle,
        progress,
        currentLayer: Math.floor((progress * totalLayers) / 100),
        totalLayers,
      }
    },
    /** What the `update` and `light` requests last set. */
    get settings() {
      return { ...settings, ...(light ? { light: { ...light } } : {}) }
    },
    setRemainingMinutes(minutes: number | undefined) {
      if (
        minutes !== undefined &&
        (!Number.isSafeInteger(minutes) || minutes < 0)
      )
        throw new Error('Invalid remaining minutes')
      remainingMinutes = minutes
      broadcast()
    },
    get extendedState() {
      return { ...extended }
    },
    get gcodeState() {
      return gcodeState
    },
    publishReport,
    disconnectClients,
    close() {
      closed = true
      stopTimer()
      clearInterval(periodicReports)
      scenario.stop()
      closing ??= Promise.all([
        broker.close(),
        http &&
          new Promise<void>((resolve) => {
            http.close(() => resolve())
            http.closeAllConnections()
          }),
      ]).then(() => {})
      return closing
    },
  }
}
