// TEST-ONLY Connector entry for the Anycubic resin journey, run as its own
// process. It qualifies the simulator's writes through the agent's code seam;
// the packaged CLI, the wire and the runtime file have no way to do that.
// It must never be pointed at a physical printer.
import { parseArgs } from 'node:util'
import {
  PHOTON_RESIN_UNREPORTED_FIRMWARE,
  type PhotonResinWrite,
} from '../../packages/connector/src/anycubic-resin/qualification.ts'
import { runConnectorAgent } from '../../packages/connector/src/runtime/agent.ts'

const { values } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: 'string' },
    'credential-file': { type: 'string' },
    'data-dir': { type: 'string' },
  },
})
const controller = new AbortController()
process.once('SIGTERM', () => controller.abort())
await runConnectorAgent({
  configPath: values.config!,
  credentialPath: values['credential-file']!,
  dataDirectory: values['data-dir']!,
  signal: controller.signal,
  onDiagnostic: (diagnostic) => console.log(JSON.stringify(diagnostic)),
  photonResinQualifiedWrites: (
    ['print-stop', 'camera'] satisfies PhotonResinWrite[]
  ).map((operation) => ({
    operation,
    model: 'Anycubic Photon P1 Max',
    firmwareVersion: PHOTON_RESIN_UNREPORTED_FIRMWARE,
  })),
})
