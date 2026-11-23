// spec-derived, not captured: https://moonraker.readthedocs.io/en/latest/external_api/printer/
import { expect, test } from 'vitest'
import type { PrinterState } from '@open3dfarmmanager/farm-protocol'
import { createMoonrakerSubscription } from '../../packages/connector/src/moonraker/subscription.ts'
import { observedTemperatureDetails } from '../../packages/connector/src/moonraker/temperature-observation.ts'
import { parseMoonrakerSnapshot } from '../../packages/connector/src/moonraker/parse.ts'
import { startMoonrakerMock } from '../../packages/sim-tools/src/mocks/index.ts'
import {
  OBSERVATION_FRESH_MS,
  projectHistory,
} from '../../apps/farm/server/utils/integration-telemetry.ts'

test('a Moonraker loopback outage leaves a gap after the last fresh observation', async () => {
  const simulator = await startMoonrakerMock({
    initial: { state: 'printing', progress: 0.25 },
  })
  const observedAt = 1000
  const url = new URL(
    '/printer/objects/query?webhooks&print_stats&virtual_sdcard',
    simulator.origin,
  )
  const printer = await (async () => {
    try {
      const response = await fetch(url)
      expect(response.ok).toBe(true)
      return parseMoonrakerSnapshot(await response.text(), {
        observedAt,
        printerKey: 'sim-moonraker',
      }).printer
    } finally {
      await simulator.close()
    }
  })()
  await expect(fetch(url)).rejects.toThrow()
  const staleAt = observedAt + OBSERVATION_FRESH_MS
  const until = staleAt + 1000
  const history = projectHistory([{ state: printer }], observedAt, until)
  expect(history.metrics[0]?.progress).toEqual({ value: 0.25, unit: 'ratio' })
  expect(history.intervals).toEqual([
    { from: observedAt, until: staleAt, state: 'printing' },
    { from: staleAt, until, state: 'gap' },
  ])
})

test('projects observed tool targets, chamber and progress detail with units', () => {
  const observedAt = 1000
  const status = {
    webhooks: { state: 'ready' },
    print_stats: {
      state: 'printing',
      print_duration: 15,
      info: { current_layer: 2, total_layer: 10 },
    },
    virtual_sdcard: { progress: 0.2 },
    extruder: { target: 210 },
    extruder1: { target: 0 },
    extruder2: { temperature: 24 },
    'heater_generic chamber': { temperature: 35, target: 40 },
    'temperature_sensor chamber': { temperature: 37 },
  }
  const { printer: snapshot } = parseMoonrakerSnapshot(
    JSON.stringify({ result: { eventtime: 1, status } }),
    { printerKey: 'moonraker-sim', observedAt },
  )
  const printer = { ...snapshot, ...observedTemperatureDetails(status) }
  const [metric] = projectHistory(
    [{ state: printer }],
    observedAt,
    observedAt + 1,
  ).metrics
  expect(metric).toMatchObject({
    currentLayer: 2,
    totalLayer: 10,
    elapsed: { value: 15, unit: 's' },
    toolTargets: [
      { tool: 0, value: 210, unit: '°C' },
      { tool: 1, value: 0, unit: '°C' },
    ],
    chamberTemperature: { value: 37, unit: '°C' },
    chamberTarget: { value: 40, unit: '°C' },
  })
  expect(metric).not.toHaveProperty('runEnergy')
  const zero = projectHistory(
    [{ state: { ...printer, runEnergyWh: 0 } }],
    observedAt,
    observedAt + 1,
  ).metrics[0]
  expect(zero?.runEnergy).toEqual({ value: 0, unit: 'Wh' })
})

test('the telemetry subscription publishes discovered heater readings', async () => {
  const simulator = await startMoonrakerMock({
    objects: [
      'webhooks',
      'print_stats',
      'virtual_sdcard',
      'extruder',
      'heater_generic chamber',
    ],
    initial: {
      state: 'printing',
      progress: 0.2,
      printDuration: 15,
      extruderTarget: 210,
    },
  })
  const controller = new AbortController()
  let notify!: (printer: PrinterState) => void
  const observed = new Promise<PrinterState>((resolve) => {
    notify = resolve
  })
  const subscription = createMoonrakerSubscription({
    assignment: { printerKey: 'sim', origin: simulator.origin },
    allowedOrigins: [simulator.origin],
    limits: {
      maxMessageBytes: 4096,
      connectTimeoutMs: 1000,
      requestTimeoutMs: 1000,
      staleAfterMs: 5000,
      reconnectMinMs: 100,
      reconnectMaxMs: 1000,
    },
    signal: controller.signal,
    jobFields: true,
    discoverObjects: true,
    onEvent(event) {
      if (
        event.kind === 'snapshot' &&
        event.printer.chamberTemperatureCelsius !== undefined
      )
        notify(event.printer)
    },
  })
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await expect(
      Promise.race([
        observed,
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('No telemetry snapshot with chamber data')),
            2500,
          )
        }),
      ]),
    ).resolves.toMatchObject({
      printDuration: 15,
      toolTargetsCelsius: [{ tool: 0, target: 210 }],
      chamberTemperatureCelsius: 20,
      chamberTargetCelsius: 0,
    })
  } finally {
    clearTimeout(timeout)
    controller.abort()
    await simulator.close()
    await subscription.done
  }
})
