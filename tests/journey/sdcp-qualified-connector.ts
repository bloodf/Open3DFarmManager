// Test composition only: the Connector run from source with the journey
// simulator's model and firmware added to the SDCP video qualification list,
// which ships empty. The product has no switch for this.
import { parseArgs } from 'node:util'
import { runConnectorAgent } from '../../packages/connector/src/runtime/agent.ts'
import {
  SDCP_JOURNEY_FIRMWARE,
  SDCP_JOURNEY_MODEL,
} from './sdcp-control-fixture.ts'

// Same arguments as `cli.js run`.
const { values } = parseArgs({
  args: process.argv.slice(3),
  options: {
    config: { type: 'string' },
    'credential-file': { type: 'string' },
    'data-dir': { type: 'string' },
  },
})
const controller = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => controller.abort())
await runConnectorAgent({
  configPath: values.config!,
  credentialPath: values['credential-file']!,
  dataDirectory: values['data-dir']!,
  signal: controller.signal,
  sdcpQualifiedVideo: [
    { model: SDCP_JOURNEY_MODEL, firmwareVersion: SDCP_JOURNEY_FIRMWARE },
  ],
  onDiagnostic(diagnostic) {
    console.log(JSON.stringify(diagnostic))
  },
})
