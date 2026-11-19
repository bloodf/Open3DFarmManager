import { expect, it } from 'vitest'
import { StatusMessage } from '../../packages/farm-protocol/src/channel.ts'
import { moonrakerMachineProfile } from '../../packages/connector/src/runtime/machine-profile.ts'
import { FARM_STATUS_PENDING_BYTES } from '../../packages/connector/src/webrtc/farm-status-sender.ts'
import { ScenarioController } from '../../packages/sim-tools/src/mocks/scenario.ts'

const settings = {
  extruder: { nozzle_diameter: 0.4, max_temp: 300 },
  extruder1: { nozzle_diameter: 0.6, max_temp: 285 },
  extruder_stepper: { nozzle_diameter: 0.8, max_temp: 999 },
  stepper_x: { position_max: 250 },
  stepper_y: { position_max: 260 },
  stepper_z: { position_max: 270 },
  heater_bed: { max_temp: 110 },
  printer: { kinematics: 'corexy' },
}

it('extracts and updates a profile from Klipper settings reports', async () => {
  const received: unknown[] = []
  const scenario = new ScenarioController({
    steps: [
      { report: { settings } },
      { report: { settings: { extruder: { nozzle_diameter: 0.8 } } } },
    ],
    getState: () => undefined,
    applyState: () => {},
    publishReport: (report) => received.push(moonrakerMachineProfile(report)),
  })
  await scenario.step()
  await scenario.step()
  expect(received).toEqual([
    {
      toolCount: 2,
      nozzleDiameterMm: { 0: 0.4, 1: 0.6 },
      bedSizeMm: { x: 250, y: 260, z: 270 },
      maxHotendTemperatureCelsius: { 0: 300, 1: 285 },
      maxBedTemperatureCelsius: 110,
      kinematics: 'corexy',
    },
    { toolCount: 1, nozzleDiameterMm: { 0: 0.8 } },
  ])
})

it('omits unknown and malformed settings without borrowing heater readings', () => {
  expect(moonrakerMachineProfile({ config: settings })).toBeUndefined()
  expect(
    moonrakerMachineProfile({
      settings: {
        extruder2: { nozzle_diameter: NaN, max_temp: '280' },
        heater_bed: { temperature: 55, target: 65 },
        stepper_y: { position_max: 260 },
      },
    }),
  ).toEqual({ bedSizeMm: { y: 260 } })
})

it('keeps an initial 100-printer snapshot with profiles inside the status frame budget', () => {
  const machine = moonrakerMachineProfile({ settings })
  expect(machine).toBeDefined()
  const snapshot = StatusMessage.parse({
    t: 'snapshot',
    seq: 1,
    printers: Array.from({ length: 100 }, (_, index) => ({
      printerKey: `printer-${index}`.padEnd(128, 'x'),
      state: 'printing',
      progress: 0.6,
      machine,
      observedAt: 1_790_000_000_000,
    })),
  })
  expect(snapshot.printers).toHaveLength(100)
  expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(
    FARM_STATUS_PENDING_BYTES,
  )
  const batch = snapshot.printers.map((state, index) => ({
    kind: 'printer-state',
    eventId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    queuedAt: state.observedAt,
    state,
  }))
  expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThan(64 * 1024)
})
