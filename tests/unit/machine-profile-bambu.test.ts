import { expect, it } from 'vitest'
import { decodeAnycubicReport } from '../../packages/connector/src/anycubic/report.ts'
import { decodeCrealityStatus } from '../../packages/connector/src/creality/index.ts'
import {
  bambuMachineProfile,
  reportedModelProfile,
} from '../../packages/connector/src/runtime/machine-profile.ts'
import { TelemetryEvent } from '../../packages/farm-protocol/src/telemetry.ts'
import { ScenarioController } from '../../packages/sim-tools/src/mocks/scenario.ts'

it('carries reported Bambu model and nozzle through telemetry validation', async () => {
  const reports: unknown[] = []
  const scenario = new ScenarioController({
    steps: [
      { report: { print: { printer_type: 'P1S', nozzle_diameter: '0.6' } } },
    ],
    getState: () => undefined,
    applyState: () => {},
    publishReport: (report) => reports.push(report),
  })
  await scenario.step()
  const event = TelemetryEvent.parse({
    kind: 'printer-state',
    eventId: '00000000-0000-4000-8000-000000000001',
    queuedAt: 2,
    state: {
      printerKey: 'bambu',
      state: 'idle',
      progress: 0,
      observedAt: 1,
      machine: bambuMachineProfile(reports[0]),
    },
  })
  expect(event).toMatchObject({
    state: { machine: { model: 'P1S', nozzleDiameterMm: { 0: 0.6 } } },
  })
})

it('omits unknown Bambu values without inferring a tool count from the model', () => {
  expect(
    bambuMachineProfile({
      print: { printer_type: 'A1', nozzle_diameter: '0.4 mm' },
    }),
  ).toEqual({
    model: 'A1',
  })
  expect(
    bambuMachineProfile({ print: { gcode_state: 'IDLE', nozzle_temper: 20 } }),
  ).toBeUndefined()
})

it('uses only the reported Creality model, even when actual and target temperatures are present', () => {
  const report = decodeCrealityStatus(
    '{"state":0,"model":"K1","nozzleTemp":22,"nozzleTemp2":220,"bedTemp2":55}',
  )
  expect(reportedModelProfile(report?.model)).toEqual({ model: 'K1' })
  expect(
    reportedModelProfile(decodeCrealityStatus('{"state":0}')?.model),
  ).toBeUndefined()
})

it('has no profile fields in Anycubic live temperature telemetry', () => {
  const report = decodeAnycubicReport(
    Buffer.from('{"state":"idle","curr_nozzle_temp":22,"curr_hotbed_temp":23}'),
  )
  expect(report).toMatchObject({
    toolTemperatureCelsius: 22,
    bedTemperatureCelsius: 23,
  })
  expect(report).not.toHaveProperty('machine')
})

it('uses the Kobra X model identifier as reported without a model lookup', () => {
  expect(reportedModelProfile('20030')).toEqual({ model: '20030' })
  expect(reportedModelProfile(undefined)).toBeUndefined()
})
