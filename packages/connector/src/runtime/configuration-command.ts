import {
  openTrustedKeyStore,
  type TrustedKeyStore,
} from '../auth/trusted-key-store.ts'
import { readAgentRuntimeConfig } from '../config/runtime.ts'
import { loadPauseIssuerKeys } from '../config/pause.ts'
import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { TelemetryQueue } from '../cloud/queue.ts'
import { readPrivateJsonFile } from '../config/local.ts'
import { canonicalize } from '../../../farm-protocol/src/canonical.ts'
import { readRuntimeCredential } from '../config/credential.ts'
import {
  readProvisioningConfig,
  type ProvisioningConfig,
} from '../config/provisioning.ts'
import { credentialLookupId } from '../config/signalling.ts'
import {
  loadExistingIdentity,
  type ConnectorIdentity,
} from '../identity/store.ts'
import { ensurePrivateDirectory } from '../provisioning/private-fs.ts'
import {
  configurationConnectorSocket,
  createConfigurationSignallingClient,
  type ConfigurationSocket,
} from '../webrtc/configuration-signalling.ts'
import type { DiscoveryScanner } from './configuration-discovery.ts'
import { createRuntimeActivator } from './configuration-activation.ts'
import {
  createConfigurationIssuerSource,
  type IssuerFetch,
} from './configuration-issuer.ts'
import {
  createConfigurationRuntime,
  type ConfigurationRuntime,
} from './configuration.ts'
import type { BambuProbe } from '../provisioning/bambu.ts'
import type { KobraXProbe } from '../provisioning/kobra-x.ts'

export interface ConfigurationCommandInput {
  trustedKeys?: TrustedKeyStore
  provisioningPath: string
  dataDirectory: string
  credentialPath: string
  signal: AbortSignal
  onDiagnostic: (event: Readonly<Record<string, unknown>>) => void
  /** Test seams; production uses the real HTTPS fetch, `ws` and telemetry runtime. */
  issuerFetch?: IssuerFetch
  socket?: () => Promise<ConfigurationSocket>
  startRuntime?: (signal: AbortSignal, configPath: string) => Promise<void>
  /** Network scan behind "search printers"; production scans the LAN. */
  discovery?: DiscoveryScanner
  /** Read-only Bambu LAN probe override, normally unset in production. */
  bambuProbe?: BambuProbe
  /** Native Kobra X connection confirmation override for loopback journeys. */
  kobraXProbe?: KobraXProbe
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

const SCOPES_DIRECTORY = 'telemetry-scopes'
const RECEIPT = 'scope.json'

function sortedAssignments(
  config: Pick<ProvisioningConfig, 'farm_id' | 'agent_id' | 'stateDirectory'>,
  configPath: string,
) {
  const runtimeConfig = readAgentRuntimeConfig(configPath, config)
  const assignments = [...runtimeConfig.assignments].sort((left, right) =>
    left.assignment_id < right.assignment_id
      ? -1
      : left.assignment_id > right.assignment_id
        ? 1
        : 0,
  )
  return assignments
}

function scopeDigest(
  config: Pick<ProvisioningConfig, 'farm_id' | 'agent_id'>,
  assignments: readonly unknown[],
): string {
  return createHash('sha256')
    .update(
      canonicalize({
        version: 1,
        farm_id: config.farm_id,
        agent_id: config.agent_id,
        assignments,
      }),
    )
    .digest('base64url')
}

/**
 * Each confirmed provisioning assignment set owns a dedicated scoped queue
 * directory so adding or removing printers through `configure` does not reuse a
 * previous scope's `scope.json` while keeping strict receipt verification intact.
 * Queued records are carried across by `handOverTelemetryScope`.
 */
export function provisioningQueueDirectory(
  config: Pick<ProvisioningConfig, 'farm_id' | 'agent_id' | 'stateDirectory'>,
  configPath: string,
): string {
  const assignments = sortedAssignments(config, configPath)
  const root = join(config.stateDirectory, SCOPES_DIRECTORY)
  ensurePrivateDirectory(root)
  return join(root, scopeDigest(config, assignments))
}

function syncPath(path: string) {
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function receiptIdentity(directory: string) {
  const entry = lstatSync(directory, { throwIfNoEntry: false })
  if (!entry?.isDirectory() || existsSync(join(directory, 'scope.pending')))
    return null
  try {
    const receipt = readPrivateJsonFile(join(directory, RECEIPT), {
      maxBytes: 64 * 1024,
    })
    return receipt && typeof receipt === 'object'
      ? (receipt as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * Carries the queue of the previous assignment set into the new scope by
 * relocating it: the old directory (records, acknowledgement cursor and all)
 * is re-receipted for the new assignments and renamed to the new scope name.
 * Event IDs and ordering are untouched, so each record is delivered exactly
 * once; only a queue whose receipt names this Connector (farm, agent and
 * fingerprint) is ever adopted. Nothing is read from a queue another process
 * holds: its lock makes the handover a no-op and the new scope starts empty.
 * Every step is idempotent, so a crash can be resumed by the next start.
 */
export function handOverTelemetryScope(input: {
  config: Pick<ProvisioningConfig, 'farm_id' | 'agent_id' | 'stateDirectory'>
  configPath: string
  fingerprint: string
  now: number
  onDiagnostic: (event: Readonly<Record<string, unknown>>) => void
}): string {
  const { config } = input
  const target = provisioningQueueDirectory(config, input.configPath)
  const root = join(config.stateDirectory, SCOPES_DIRECTORY)
  const assignments = sortedAssignments(config, input.configPath)
  const previous = readdirSync(root)
    .map((name) => join(root, name))
    .filter((path) => path !== target)
    .flatMap((path) => {
      const receipt = receiptIdentity(path)
      return receipt &&
        receipt.farm_id === config.farm_id &&
        receipt.agent_id === config.agent_id &&
        receipt.fingerprint === input.fingerprint
        ? [{ path, modified: lstatSync(join(path, RECEIPT)).mtimeMs }]
        : []
    })
    .sort((left, right) => right.modified - left.modified)
  if (existsSync(target)) {
    if (previous.length)
      input.onDiagnostic({
        kind: 'telemetry-scope-handover',
        result: 'previous-scope-left',
        count: previous.length,
      })
    return target
  }
  const source = previous[0]
  if (!source) return target
  try {
    // Opening takes the queue lock and validates the log before anything moves.
    const queue = new TelemetryQueue(source.path, input.now)
    try {
      const receipt = join(source.path, RECEIPT)
      const staged = join(source.path, 'scope.handover')
      // Only a crashed earlier handover leaves this, and we hold the lock.
      if (existsSync(staged)) unlinkSync(staged)
      const fd = openSync(
        staged,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      )
      try {
        writeFileSync(
          fd,
          canonicalize({
            version: 1,
            farm_id: config.farm_id,
            agent_id: config.agent_id,
            fingerprint: input.fingerprint,
            assignments,
          }) + '\n',
        )
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(staged, receipt)
      syncPath(source.path)
    } finally {
      queue.close()
    }
    renameSync(source.path, target)
    syncPath(root)
    input.onDiagnostic({
      kind: 'telemetry-scope-handover',
      result: 'carried',
      remaining: previous.length - 1,
    })
  } catch {
    // Locked, damaged or unreviewed: never adopt it. The new scope starts empty.
    input.onDiagnostic({
      kind: 'telemetry-scope-handover',
      result: 'operator-review',
    })
  }
  return target
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
  let trustedKeys = input.trustedKeys
  if (!trustedKeys && existsSync(config.runtimeConfigPath)) {
    const runtimeConfig = readAgentRuntimeConfig(
      config.runtimeConfigPath,
      config,
    )
    if (runtimeConfig.pause) {
      trustedKeys = await openTrustedKeyStore({
        path: join(input.dataDirectory, 'trusted-keys.json'),
        farmId: config.farm_id,
        issuers: await loadPauseIssuerKeys(runtimeConfig.pause),
        onDiagnostic: (kind) => input.onDiagnostic({ kind }),
      })
    }
  }
  const startRuntime =
    input.startRuntime ??
    (async (signal: AbortSignal, configPath: string) => {
      const { runConnectorAgent } = await import('./agent.ts')
      await runConnectorAgent({
        configPath,
        ...(trustedKeys ? { trustedKeys: trustedKeys.authority } : {}),
        credentialPath: input.credentialPath,
        dataDirectory: input.dataDirectory,
        telemetryDirectory: handOverTelemetryScope({
          config,
          configPath,
          fingerprint: identity.fingerprint,
          now: clock(),
          onDiagnostic: input.onDiagnostic,
        }),
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
    ...(trustedKeys ? { trustedKeys } : {}),
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
    ...(input.discovery ? { discovery: input.discovery } : {}),
    ...(input.bambuProbe ? { bambuProbe: input.bambuProbe } : {}),
    ...(input.kobraXProbe ? { kobraXProbe: input.kobraXProbe } : {}),
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
