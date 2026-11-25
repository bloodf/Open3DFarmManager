import { startFormlabsSimulator } from '../../packages/sim-tools/src/formlabs-simulator.ts'
import { devices } from '../fixtures/formlabs/devices.ts'

const DEVICE_ID = 'Form4-Example'
const withDevice = (patch: Record<string, unknown>) => ({
  ...devices,
  devices: devices.devices.map((device) =>
    device.id === DEVICE_ID ? { ...device, ...patch } : device,
  ),
})

/** Synthetic loopback protocol only; never discovers or contacts hardware. */
export async function startFormlabsJourneyFixture() {
  const simulator = await startFormlabsSimulator()
  simulator.setResponse(devices)
  return {
    simulator,
    deviceId: DEVICE_ID,
    /** The catalog model the owner binds to the device. */
    model: 'Form 4' as const,
    loseConnection: () => simulator.setResponse({}, 503),
    /** The print ends: the host reports Idle and no remaining time. */
    recover: () =>
      simulator.setResponse(
        withDevice({ status: 'Idle', estimated_print_time_remaining_ms: 0 }),
      ),
    /** The host lists another model under the bound device ID. */
    reportModel: (productName: string) =>
      simulator.setResponse(
        withDevice({ status: 'Idle', product_name: productName }),
      ),
    close: () => simulator.close(),
  }
}
