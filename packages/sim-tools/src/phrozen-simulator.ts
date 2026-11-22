import { startSdcpSimulator } from './sdcp-simulator.ts'

export function startPhrozenSimulator(
  fixture: Parameters<typeof startSdcpSimulator>[0],
  fault?: Parameters<typeof startSdcpSimulator>[1],
) {
  return startSdcpSimulator(fixture, fault)
}
