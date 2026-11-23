import { startFormlabsSimulator } from '../../packages/sim-tools/src/formlabs-simulator.ts'
import { devices } from '../fixtures/formlabs/devices.ts'

/** Synthetic loopback protocol only; never discovers or contacts hardware. */
export async function startFormlabsJourneyFixture() {
  const simulator = await startFormlabsSimulator()
  simulator.setResponse(devices)
  return {
    simulator,
    deviceId: 'Form4-Example',
    loseConnection: () => simulator.setResponse({}, 503),
    recover: () =>
      simulator.setResponse({
        ...devices,
        devices: devices.devices.map((device) =>
          device.id === 'Form4-Example'
            ? { ...device, status: 'Idle' }
            : device,
        ),
      }),
    close: () => simulator.close(),
  }
}
