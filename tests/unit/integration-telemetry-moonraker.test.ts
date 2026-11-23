// spec-derived, not captured: https://moonraker.readthedocs.io/en/latest/external_api/printer/
import { expect, test } from 'vitest'
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
  const { printer } = parseMoonrakerSnapshot(
    JSON.stringify({
      result: {
        eventtime: 1,
        status: {
          webhooks: { state: 'ready' },
          print_stats: {
            state: 'printing',
            print_duration: 15,
            info: {
              current_layer: 2,
              total_layer: 10,
            },
          },
          virtual_sdcard: { progress: 0.2 },
          extruder: { target: 210 },
          extruder1: { target: 0 },
          extruder2: { temperature: 24 },
          'heater_generic chamber': { temperature: 35, target: 40 },
          'temperature_sensor chamber': { temperature: 37 },
        },
      },
    }),
    { printerKey: 'moonraker-sim', observedAt },
  )
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
