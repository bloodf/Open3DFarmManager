// SPDX-License-Identifier: MIT
import { startMqttBroker, type MqttMockInstance } from './mqtt-broker.ts'
import type { ThrowawayTlsMaterial } from './tls.ts'
import type { ScenarioStep } from './scenario.ts'
import type { FaultController } from './faults.ts'

export type KobraXPrintState =
  'idle' | 'printing' | 'paused' | 'finished' | 'error'

export interface KobraXMockOptions {
  serial?: string | undefined
  initialState?: KobraXPrintState | undefined
  printDurationMs?: number | undefined
  totalLayers?: number | undefined
  tls?: ThrowawayTlsMaterial | undefined
  reuseSharedTls?: boolean | undefined
  scenario?: ScenarioStep[] | undefined
}

export interface KobraXMockInstance {
  origin: string
  ports: { default: number; mqtt: number } & number[]
  control: {
    faults: FaultController
    scenario: MqttMockInstance['control']['scenario']
    publishReport: (data: unknown) => void
    setState: (state: KobraXPrintState) => void
    setPrintProgress: (progress: number) => void
    finishPrint: () => void
    failPrint: () => void
    getState: () => {
      state: KobraXPrintState
      progress: number
      extended: Record<string, unknown>
    }
  }
  calls: MqttMockInstance['calls']
  close: () => Promise<void>
}

export async function startKobraXMock(
  options: KobraXMockOptions = {},
): Promise<KobraXMockInstance> {
  const serial = options.serial ?? 'SYNTHETIC_KOBRA_X'
  const reportTopic = `anycubic/anycubicCloud/v1/printer/public/${serial}/info/report`
  const requestTopic = `anycubic/anycubicCloud/v1/printer/public/${serial}/cmd/request`
  const totalLayers = options.totalLayers ?? 100

  let state: KobraXPrintState = options.initialState ?? 'idle'
  let progress = 0
  const extended: Record<string, unknown> = {}

  let timer: ReturnType<typeof setInterval> | undefined

  function stopTimer() {
    if (timer) {
      clearInterval(timer)
      timer = undefined
    }
  }

  const broker = await startMqttBroker({
    tls: options.tls,
    reuseSharedTls: options.reuseSharedTls,
    scenario: options.scenario,
    onPublish: (msg) => {
      if (msg.topic === requestTopic) {
        try {
          const value = JSON.parse(msg.payload.toString('utf8'))
          const cmd = value?.cmd ?? value?.command
          if (cmd === 'pause') {
            state = 'paused'
            stopTimer()
          } else if (cmd === 'resume') {
            state = 'printing'
          } else if (cmd === 'stop' || cmd === 'cancel') {
            state = 'idle'
            stopTimer()
          }
          publishReport()
        } catch {
          // ignore parsing error
        }
      }
    },
  })

  function publishReport(extra?: unknown) {
    broker.control.publish(reportTopic, {
      data: {
        state,
        progress,
        curr_layer: Math.floor((progress * totalLayers) / 100),
        total_layers: totalLayers,
        ...extended,
        ...(typeof extra === 'object' && extra ? extra : {}),
      },
    })
  }

  const periodicTimer = setInterval(() => {
    if (state === 'printing') {
      publishReport()
    }
  }, 100)

  const setState = (newState: KobraXPrintState) => {
    state = newState
    publishReport()
  }

  const setPrintProgress = (p: number) => {
    state = 'printing'
    progress = p
    publishReport()
  }

  const finishPrint = () => {
    stopTimer()
    state = 'finished'
    progress = 100
    publishReport()
  }

  const failPrint = () => {
    stopTimer()
    state = 'error'
    publishReport()
  }

  const close = async () => {
    stopTimer()
    clearInterval(periodicTimer)
    await broker.close()
  }

  return {
    origin: broker.origin,
    ports: broker.ports,
    control: {
      faults: broker.control.faults,
      scenario: broker.control.scenario,
      publishReport: (data) => broker.control.publish(reportTopic, data),
      setState,
      setPrintProgress,
      finishPrint,
      failPrint,
      getState: () => ({ state, progress, extended: { ...extended } }),
    },
    calls: broker.calls,
    close,
  }
}
