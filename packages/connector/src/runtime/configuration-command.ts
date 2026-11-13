import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readRuntimeCredential } from '../config/credential.ts'
import { readProvisioningConfig } from '../config/provisioning.ts'
import { credentialLookupId } from '../config/signalling.ts'
import {
  loadExistingIdentity,
  type ConnectorIdentity,
} from '../identity/store.ts'
import {
  configurationConnectorSocket,
  createConfigurationSignallingClient,
  type ConfigurationSocket,
} from '../webrtc/configuration-signalling.ts'
import { createRuntimeActivator } from './configuration-activation.ts'
import {
  createConfigurationIssuerSource,
  type IssuerFetch,
} from './configuration-issuer.ts'
import {
  createConfigurationRuntime,
  type ConfigurationRuntime,
} from './configuration.ts'

export interface ConfigurationCommandInput {
  provisioningPath: string
  dataDirectory: string
  credentialPath: string
  signal: AbortSignal
  onDiagnostic: (event: Readonly<Record<string, unknown>>) => void
  /** Test seams; production uses the real HTTPS fetch, `ws` and telemetry runtime. */
  issuerFetch?: IssuerFetch
  socket?: () => Promise<ConfigurationSocket>
  startRuntime?: (signal: AbortSignal, configPath: string) => Promise<void>
  clock?: () => number
}

function currentCredential(
  path: string,
  identity: ConnectorIdentity,
  clock: () => number,
) {
  try {
    const credential = readRuntimeCredential(
      path,
      identity.fingerprint,
      clock(),
    )
    return {
      token: credential.device_token,
      jti: credentialLookupId(credential.device_token),
      agentId: credential.agent_id,
      farmId: credential.farm_id,
    }
  } catch {
    return null
  }
}

/** Local, secret-free readiness snapshot for `configure --check`. */
export async function configurationReadiness(input: {
  provisioningPath: string
  dataDirectory: string
  credentialPath: string
  clock?: () => number
}) {
  const clock = input.clock ?? Date.now
  const identity = loadExistingIdentity(input.dataDirectory)
  const config = readProvisioningConfig(input.provisioningPath)
  const credential = currentCredential(input.credentialPath, identity, clock)
  if (
    !credential ||
    credential.agentId !== config.agent_id ||
    credential.farmId !== config.farm_id
  )
    throw new Error('Credential does not match provisioning scope')
  return Object.freeze({
    fingerprint: identity.fingerprint,
    farm_id: config.farm_id,
    agent_id: config.agent_id,
    mode: config.mode,
    managedBridge: config.managedBridge !== null,
    runtime: existsSync(config.runtimeConfigPath) ? 'present' : 'absent',
  })
}

/**
 * `configure`: runs the config-v1 provisioning Connector. A zero-printer
 * Connector waits for an authenticated owner/admin session; after each local
 * commit the existing telemetry runtime is (re)started from the committed
 * file. Shared engines are never started here.
 */
export async function runConfigurationConnector(
  input: ConfigurationCommandInput,
): Promise<void> {
  const clock = input.clock ?? Date.now
  const identity = loadExistingIdentity(input.dataDirectory)
  const config = readProvisioningConfig(input.provisioningPath)
  const credential = () =>
    currentCredential(input.credentialPath, identity, clock)
  const first = credential()
  if (
    !first ||
    first.agentId !== config.agent_id ||
    first.farmId !== config.farm_id
  )
    throw new Error('Credential does not match provisioning scope')
  const startRuntime =
    input.startRuntime ??
    (async (signal: AbortSignal, configPath: string) => {
      const { runConnectorAgent } = await import('./agent.ts')
      await runConnectorAgent({
        configPath,
        credentialPath: input.credentialPath,
        dataDirectory: input.dataDirectory,
        signal,
        onDiagnostic: (value) => input.onDiagnostic(value),
      })
    })
  const activator = createRuntimeActivator({
    runtimeConfigPath: config.runtimeConfigPath,
    scope: { agent_id: config.agent_id, farm_id: config.farm_id },
    start: startRuntime,
    snapshotPath: join(config.stateDirectory, 'collection-snapshot.json'),
    onDiagnostic: input.onDiagnostic,
  })
  const issuers = createConfigurationIssuerSource({
    farmOrigin: config.farmOrigin,
    ...(input.issuerFetch ? { fetch: input.issuerFetch } : {}),
    clock,
  })
  let runtime: ConfigurationRuntime | undefined
  if (!process.env.WS_NO_BUFFER_UTIL) process.env.WS_NO_BUFFER_UTIL = '1'
  if (!process.env.WS_NO_UTF_8_VALIDATE) process.env.WS_NO_UTF_8_VALIDATE = '1'
  const signalling = createConfigurationSignallingClient({
    identity,
    farmOrigin: config.farmOrigin,
    credentialAudience: config.credentialAudience,
    farmId: config.farm_id,
    agentId: config.agent_id,
    credential: () => {
      const value = credential()
      return value ? { token: value.token, jti: value.jti } : null
    },
    runtime: () => {
      if (!runtime) throw new Error('Runtime not ready')
      return runtime
    },
    socket:
      input.socket ?? (() => configurationConnectorSocket(config.farmOrigin)),
    ...(config.rtc ? { bindAddress: config.rtc.bindAddress } : {}),
    clock,
    onDiagnostic: input.onDiagnostic,
  })
  runtime = createConfigurationRuntime({
    identity,
    config,
    issuers,
    activator,
    serverOnline: signalling.online,
    credentialJti: () => credential()?.jti ?? null,
    clock,
    onDiagnostic: input.onDiagnostic,
  })
  const started = await runtime.start()
  input.onDiagnostic({ kind: 'configuration-ready', ...started })
  try {
    await signalling.run(input.signal)
  } finally {
    await runtime.shutdown()
  }
}
