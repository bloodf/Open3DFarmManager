// Child entry of the journey's second Connector (configuration mode). It runs
// the real `configure` runtime against the app and answers "search printers"
// with the loopback probes the harness hands in; nothing else is replaced.
// Started only by harness-configurator.ts with an isolated environment.
import { probeAnycubic } from '../../packages/connector/src/discovery/anycubic.ts'
import { probeCreality } from '../../packages/connector/src/discovery/creality.ts'
import type { Printer } from '../../packages/connector/src/discovery/index.ts'
import { probeBambuLan } from '../../packages/connector/src/provisioning/bambu.ts'
import { runConfigurationConnector } from '../../packages/connector/src/runtime/configuration-command.ts'

type Probes = Readonly<{
  creality?: number
  anycubic?: number
  bambuPort?: number
}>

async function main() {
  const env = process.env
  const provisioningPath = env.JOURNEY_CONFIG_PROVISIONING
  const credentialPath = env.JOURNEY_CONFIG_CREDENTIAL
  const dataDirectory = env.JOURNEY_CONFIG_DATA
  if (
    env.JOURNEY_CONFIG_CHILD !== 'yes' ||
    !env.NODE_EXTRA_CA_CERTS ||
    !provisioningPath ||
    !credentialPath ||
    !dataDirectory
  )
    throw new Error('Explicit isolated child startup required')
  const probes = JSON.parse(env.JOURNEY_CONFIG_PROBES ?? '{}') as Probes
  const abort = new AbortController()
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.once(signal, () => abort.abort())
  await runConfigurationConnector({
    provisioningPath,
    credentialPath,
    dataDirectory,
    signal: abort.signal,
    onDiagnostic: (event) => console.log(JSON.stringify(event)),
    async discovery() {
      const found = await Promise.all([
        probes.creality === undefined
          ? undefined
          : probeCreality('127.0.0.1', { https: 1, http: probes.creality }),
        probes.anycubic === undefined
          ? undefined
          : probeAnycubic('127.0.0.1', probes.anycubic),
      ])
      return found.filter(
        (printer): printer is Printer => printer !== undefined,
      )
    },
    ...(probes.bambuPort === undefined
      ? {}
      : {
          bambuProbe: (input) =>
            probeBambuLan({ ...input, port: probes.bambuPort! }),
        }),
  })
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  },
)
