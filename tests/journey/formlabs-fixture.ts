import { startFormlabsSimulator } from '../../packages/sim-tools/src/formlabs-simulator.ts'
import { devices } from '../fixtures/formlabs/devices.ts'

/** Synthetic loopback protocol only; never discovers or contacts hardware. */
export async function startFormlabsJourneyFixture() {
  const simulator = await startFormlabsSimulator()
  simulator.setResponse(devices)
  return {
    simulator,
    loseConnection: () => simulator.setResponse({}, 503),
    recover: () => simulator.setResponse(devices),
    close: () => simulator.close(),
  }
}
