import { prusaLinkBinding } from '../../packages/connector/src/prusa/models.ts'
import { startPrusaLinkPrinterSimulator } from '../../packages/sim-tools/src/prusa-simulator.ts'

/** Only binds loopback and serves synthetic PrusaLink responses. */
export async function startPrusaLinkJourneyFixture(model = 'Prusa MK4') {
  const apiKey = 'journey-prusa-key'
  const serial = 'SIM-PRUSA'
  // Only the wire identity is needed here; the harness supplies the rest.
  const { printerType } = prusaLinkBinding({
    model,
    printerKey: 'journey',
    origin: 'http://127.0.0.1',
    apiKeyFile: '/unused',
    serial,
  }).expect
  const simulator = await startPrusaLinkPrinterSimulator({
    serial,
    apiKey,
    printerType,
  })
  simulator.startLocalPrint('journey.gcode')
  return {
    simulator,
    apiKey,
    serial,
    printerType,
    requests: simulator.requests,
    /** The printer asks for someone at its screen, then gets busy. */
    askForAttention: () => simulator.setCondition('ATTENTION'),
    getBusy: () => simulator.setCondition('BUSY'),
    resumePrinting: () => simulator.setCondition(undefined),
    loseConnection: () => simulator.setOnline(false),
    /** The print finished while the printer was unreachable. */
    recover: () => {
      simulator.finishPrint()
      simulator.setOnline(true)
    },
    close: () => simulator.close(),
  }
}
