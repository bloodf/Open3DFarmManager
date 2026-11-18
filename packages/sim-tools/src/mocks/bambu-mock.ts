// SPDX-License-Identifier: MIT
import { startMqttBroker, type MqttMessage, type MqttMockInstance } from './mqtt-broker.ts'
import type { ThrowawayTlsMaterial } from './tls.ts'
import type { ScenarioStep } from './scenario.ts'
import type { FaultController } from './faults.ts'

export interface BambuMockOptions {
  serial?: string | undefined
  initialState?: 'RUNNING' | 'PAUSE' | 'IDLE' | undefined
  initialTargetTemperature?: number | undefined
  printDurationMs?: number | undefined
  totalLayers?: number | undefined
  confirmCommands?: boolean | undefined
  versionModules?: { name: string; sw_ver: string }[] | undefined
  tls?: ThrowawayTlsMaterial | undefined
  reuseSharedTls?: boolean | undefined
  scenario?: ScenarioStep[] | undefined
}

export interface BambuMockInstance {
  origin: string
  ports: { default: number; mqtt: number } & number[]
  control: {
    faults: FaultController
    scenario: MqttMockInstance['control']['scenario']
    publishReport: (value: unknown) => void
    setPrintProgress: (percent: number) => void
    finishPrint: () => void
    failPrint: () => void
    uploadFile: (name: string, data: Uint8Array) => void
    getState: () => { gcodeState?: string | undefined; extended: Record<string, unknown> }
    requests: Array<{ command: string; sequence_id: string; param?: unknown | undefined }>
  }
  calls: MqttMockInstance['calls']
  close: () => Promise<void>
}

export async function startBambuMock(
  options: BambuMockOptions = {},
): Promise<BambuMockInstance> {
  const serial = options.serial ?? 'SYNTHETIC'
  const reportTopic = `device/${serial}/report`
  const requestTopic = `device/${serial}/request`
  const totalLayers = options.totalLayers ?? 100

  let gcodeState: string | undefined = options.initialState
  const extended: Record<string, unknown> =
    options.initialTargetTemperature !== undefined
      ? { nozzle_target_temper: options.initialTargetTemperature }
      : {}

  const requests: Array<{ command: string; sequence_id: string; param?: unknown }> = []
  const uploads = new Set<string>()

  let timer: ReturnType<typeof setInterval> | undefined
  let elapsed = 0
  let lastTick = 0

  function stopPrintTimer() {
    if (timer) {
      clearInterval(timer)
      timer = undefined
    }
  }

  function startPrintTimer(broker: MqttMockInstance) {
    if (options.printDurationMs === undefined) return
    stopPrintTimer()
    lastTick = Date.now()
    timer = setInterval(() => {
      const now = Date.now()
      elapsed += now - lastTick
      lastTick = now
      const fraction = Math.min(elapsed / options.printDurationMs!, 1)
      extended.mc_percent = Math.floor(fraction * 100)
      extended.layer_num = Math.floor(fraction * totalLayers)
      extended.total_layer_num = totalLayers

      if (fraction >= 1) {
        gcodeState = 'FINISH'
        stopPrintTimer()
      }

      broker.control.publish(reportTopic, {
        print: { gcode_state: gcodeState, mc_percent: extended.mc_percent, ...extended },
      })
    }, Math.min(100, Math.max(5, options.printDurationMs / 10)))
  }

  let brokerInstance: MqttMockInstance | undefined

  const broker = await startMqttBroker({
    tls: options.tls,
    reuseSharedTls: options.reuseSharedTls,
    scenario: options.scenario,
    onPublish: (msg) => {
      if (msg.topic === requestTopic) {
        try {
          const value = JSON.parse(msg.payload.toString('utf8'))
          if (value?.info?.command === 'get_version') {
            requests.push({
              command: 'get_version',
              sequence_id: value.info.sequence_id,
            })
            if (options.versionModules) {
              broker.control.publish(reportTopic, {
                info: { command: 'get_version', module: options.versionModules },
              })
            }
            return
          }

          const request = value?.print ?? value?.system
          const command = request?.command
          if (typeof command === 'string') {
            requests.push({
              command,
              sequence_id: request.sequence_id,
              param: request.param,
            })

            if (options.confirmCommands !== false) {
              if (command === 'pause') {
                gcodeState = 'PAUSE'
                stopPrintTimer()
              } else if (command === 'resume') {
                gcodeState = 'RUNNING'
                startPrintTimer(broker)
              } else if (command === 'stop') {
                gcodeState = 'IDLE'
                stopPrintTimer()
              } else if (command === 'ledctrl' && request.led_mode) {
                extended.light = request.led_mode
              } else if (command === 'print_speed' && request.param) {
                extended.speed = request.param
              } else if (command === 'project_file' && typeof request.url === 'string') {
                extended.file = request.url
                gcodeState = 'RUNNING'
                elapsed = 0
                extended.mc_percent = 0
                if (options.printDurationMs !== undefined) {
                  startPrintTimer(broker)
                }
              }

              broker.control.publish(reportTopic, {
                print: { gcode_state: gcodeState, mc_percent: 25, ...extended },
              })
            }
          }
        } catch {
          // ignore parsing error
        }
      }
    },
  })
  brokerInstance = broker

  // Set up periodic status report if running
  const periodicReportTimer = setInterval(() => {
    if (gcodeState) {
      broker.control.publish(reportTopic, {
        print: { gcode_state: gcodeState, mc_percent: 25, ...extended },
      })
    }
  }, 100)

  const publishReport = (val: unknown) => {
    broker.control.publish(reportTopic, val)
  }

  const setPrintProgress = (percent: number) => {
    stopPrintTimer()
    gcodeState = 'RUNNING'
    extended.mc_percent = percent
    publishReport({
      print: { gcode_state: gcodeState, mc_percent: percent, ...extended },
    })
  }

  const finishPrint = () => {
    stopPrintTimer()
    gcodeState = 'FINISH'
    extended.mc_percent = 100
    publishReport({
      print: { gcode_state: gcodeState, mc_percent: 100, ...extended },
    })
  }

  const failPrint = () => {
    stopPrintTimer()
    gcodeState = 'FAILED'
    publishReport({
      print: { gcode_state: gcodeState, ...extended },
    })
  }

  const uploadFile = (name: string, data: Uint8Array) => {
    uploads.add(`file:///sdcard/${name}`)
  }

  const close = async () => {
    stopPrintTimer()
    clearInterval(periodicReportTimer)
    await broker.close()
  }

  return {
    origin: broker.origin,
    ports: broker.ports,
    control: {
      faults: broker.control.faults,
      scenario: broker.control.scenario,
      publishReport,
      setPrintProgress,
      finishPrint,
      failPrint,
      uploadFile,
      getState: () => ({ gcodeState, extended: { ...extended } }),
      requests,
    },
    calls: broker.calls,
    close,
  }
}
