// Simulator journeys only. The Connector from source with a test-only Anycubic
// FDM write qualification, which the shipped CLI cannot set: its list is empty.
// Takes the arguments of `cli.ts run`.
import { parseArgs } from 'node:util'
import { runConnectorAgent } from '../../packages/connector/src/runtime/agent.ts'
import { ANYCUBIC_SIM_FIRMWARE } from '../../packages/sim-tools/src/anycubic-simulator.ts'

const { values } = parseArgs({
  args: process.argv.slice(3),
  options: {
    config: { type: 'string' },
    'data-dir': { type: 'string' },
    'credential-file': { type: 'string' },
  },
})
const controller = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => controller.abort())
await runConnectorAgent({
  configPath: values.config!,
  dataDirectory: values['data-dir']!,
  credentialPath: values['credential-file']!,
  anycubicQualifiedWrites: Object.entries(ANYCUBIC_SIM_FIRMWARE).map(
    ([modelId, firmwareVersion]) => ({ modelId, firmwareVersion }),
  ),
  signal: controller.signal,
  onDiagnostic(diagnostic) {
    console.log(JSON.stringify(diagnostic))
  },
})
