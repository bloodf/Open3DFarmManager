// Simulator journeys only. The Connector from source with a test-only Phrozen
// write qualification, which the shipped CLI cannot set: its list is empty.
// Takes the arguments of `cli.ts run`.
import { parseArgs } from 'node:util'
import { runConnectorAgent } from '../../packages/connector/src/runtime/agent.ts'

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
  phrozenQualifiedWrites: [
    { model: 'Sonic Mighty Revo 14K', firmwareVersion: 'V153' },
  ],
  signal: controller.signal,
  onDiagnostic(diagnostic) {
    console.log(JSON.stringify(diagnostic))
  },
})
