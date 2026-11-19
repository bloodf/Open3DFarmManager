// The journey's second Connector: a paired, approved Connector in
// configuration mode (no printers), so the Impressoras page can open its
// config-v1 session and search for printers. The search answers with the
// loopback discovery responders of the vendor simulators; everything else is
// the real `configure` runtime in its own process.
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { loadOrCreateIdentity } from '../../packages/connector/src/identity/store.ts'
import {
  PairingPollResponse,
  PairingStartResponse,
} from '../../packages/farm-protocol/src/pairing.ts'
import { PairingProofChallenge } from '../../packages/farm-protocol/src/pairing-proof.ts'
import { pagePost } from '../helpers/kobralink-rtc/acceptance.ts'

import type { discoverPrinters } from '../../packages/connector/src/discovery/index.ts'

export type ConfiguratorPrinter = Readonly<{
  assignmentId: string
  agentId: string
  printerKey: string
  origin: string
}>

export type Configurator = Readonly<{
  agentId: string
  fingerprint: string
  assignments: readonly ConfiguratorPrinter[]
  /** Bounded child output tail for failure diagnostics. */
  log(): string
  close(): Promise<void>
}>

export async function startConfigurator(input: {
  origin: string
  audience: string
  farmId: string
  certificatePath: string
  ownerPage: Page
  machinePost(path: string, body: unknown): Promise<unknown>
  /** Loopback discovery responder ports (info endpoints) per vendor. */
  probes: Readonly<{
    creality?: number
    anycubic?: number
    bambuPort?: number
    kobraX?: Readonly<{ httpPort: number; mqttPort: number }>
    discovery?: Parameters<typeof discoverPrinters>[0]
  }>
  /** Existing Moonraker printers activated immediately alongside config-v1. */
  initialPrinters?: readonly { printerKey: string; origin: string }[]
  /** Private host route allowed for the loopback Bambu simulator. */
  printerNetworks?: readonly string[]
}): Promise<Configurator> {
  // Provisioning storage refuses any symbolic link in its path; the macOS
  // default temporary directory (/var/folders) is one, so resolve it first.
  // Connector storage rejects symlinked ancestors (macOS /var -> /private/var).
  const root = await realpath(
    await mkdtemp(join(await realpath(tmpdir()), 'journey-configurator-')),
  )
  const dataDirectory = join(root, 'identity')
  await mkdir(dataDirectory, { mode: 0o700 })
  const identity = loadOrCreateIdentity(dataDirectory)
  const started = PairingStartResponse.parse(
    await input.machinePost('/api/connector-pairing/start', {
      public_key_spki: identity.publicKeySpki,
      platform: 'linux',
      version: '0.0.1',
    }),
  )
  const pairing = PairingProofChallenge.parse(
    await input.machinePost('/api/connector-pairing/challenge', {
      device_code: started.device_code,
    }),
  )
  await input.machinePost('/api/connector-pairing/proof', {
    device_code: started.device_code,
    challenge: pairing,
    signature: identity.signPairingProof({
      challenge: pairing,
      expectedOrigin: input.origin,
      expectedAudience: input.audience,
      now: Date.now(),
    }),
  })
  await pagePost(input.ownerPage, '/api/connector-pairing/approve', {
    user_code: started.user_code,
    farm_id: input.farmId,
    expected_fingerprint: identity.fingerprint,
  })
  const claim = PairingPollResponse.parse(
    await input.machinePost('/api/connector-pairing/claim', {
      device_code: started.device_code,
    }),
  )
  if (claim.status !== 'approved' || claim.farm_id !== input.farmId)
    throw new Error('Configurator pairing did not complete')

  const credentialPath = join(root, 'credential.json')
  const provisioningPath = join(root, 'provisioning.json')
  const runtimeConfigPath = join(root, 'runtime.json')
  const assignments: ConfiguratorPrinter[] = []
  if (input.initialPrinters?.length) {
    const printersPath = `/api/farms/${input.farmId}/printers`
    for (const printer of input.initialPrinters) {
      const registration = (await pagePost(input.ownerPage, printersPath, {
        agentId: claim.agent_id,
        printerKey: printer.printerKey,
        confirmedLocalConfiguration: true,
      })) as { assignmentId?: unknown }
      if (typeof registration.assignmentId !== 'string')
        throw new Error('Configurator initial printer assignment failed')
      assignments.push(
        Object.freeze({
          assignmentId: registration.assignmentId,
          agentId: claim.agent_id,
          printerKey: printer.printerKey,
          origin: printer.origin,
        }),
      )
    }
    await writeFile(
      runtimeConfigPath,
      JSON.stringify({
        version: 1,
        collection: {
          version: 1,
          allowedOrigins: [...new Set(assignments.map((p) => p.origin))],
          printers: assignments.map((p) => ({
            printerKey: p.printerKey,
            origin: p.origin,
          })),
          limits: { staleAfterMs: 5000 },
        },
        assignments: assignments.map((p) => ({
          assignment_id: p.assignmentId,
          agent_id: p.agentId,
          farm_id: input.farmId,
          printer_key: p.printerKey,
          moonraker_origin: p.origin,
        })),
        telemetry: {
          endpoint: input.origin + '/api/connector/telemetry',
          audience: input.audience,
          retryMinMs: 1000,
          retryMaxMs: 1000,
        },
        signalling: {
          endpoint:
            input.origin.replace('https:', 'wss:') +
            '/api/signalling/connector',
          origin: input.origin,
          audience: input.audience,
          retryMinMs: 1000,
          retryMaxMs: 1000,
        },
        rtc: { bindAddress: '127.0.0.1' },
      }),
      { mode: 0o600, flag: 'wx' },
    )
  }
  await writeFile(
    credentialPath,
    JSON.stringify({
      version: 1,
      expected_fingerprint: identity.fingerprint,
      approval: claim,
    }),
    { mode: 0o600, flag: 'wx' },
  )
  await writeFile(
    provisioningPath,
    JSON.stringify({
      version: 1,
      mode: 'configuration-provisioning',
      farm_id: input.farmId,
      agent_id: claim.agent_id,
      farmOrigin: input.origin,
      credentialAudience: input.audience,
      stateDirectory: join(root, 'state'),
      runtimeConfigPath,
      printerNetworks: input.printerNetworks ?? ['172.30.78.0/24'],
      managedBridge: null,
      runtimeTemplate: {
        telemetry: {
          endpoint: input.origin + '/api/connector/telemetry',
          audience: input.audience,
        },
        signalling: {
          endpoint:
            input.origin.replace('https:', 'wss:') +
            '/api/signalling/connector',
          origin: input.origin,
          audience: input.audience,
        },
        rtc: { bindAddress: '127.0.0.1' },
      },
      rtc: { bindAddress: '127.0.0.1' },
    }),
    { mode: 0o600, flag: 'wx' },
  )

  let tail = ''
  let configReady = false
  let readonlyReady = assignments.length === 0
  const collect = (chunk: Buffer) => {
    tail = (tail + chunk.toString('utf8')).slice(-8192)
    if (tail.includes('"configuration-signalling","state":"ready"'))
      configReady = true
    if (tail.includes('"kind":"readonly-listening"')) readonlyReady = true
  }
  const child: ChildProcess = spawn(
    process.execPath,
    [new URL('./configurator-child.ts', import.meta.url).pathname],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        NODE_OPTIONS: process.env.OPENFARM_NETWORK_GUARD_PRELOAD ?? '',
        NODE_EXTRA_CA_CERTS: input.certificatePath,
        NODE_TLS_REJECT_UNAUTHORIZED: '1',
        WS_NO_BUFFER_UTIL: '1',
        WS_NO_UTF_8_VALIDATE: '1',
        JOURNEY_CONFIG_CHILD: 'yes',
        JOURNEY_CONFIG_PROVISIONING: provisioningPath,
        JOURNEY_CONFIG_CREDENTIAL: credentialPath,
        JOURNEY_CONFIG_DATA: dataDirectory,
        JOURNEY_CONFIG_PROBES: JSON.stringify(input.probes),
        PATH: process.env.PATH ?? '',
      },
    },
  )
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)
  // Hand it over once it has opened its signalling (a loaded host needs time).
  const deadline = Date.now() + 5 * 60_000
  while (!(configReady && readonlyReady)) {
    if (child.exitCode !== null || Date.now() > deadline) {
      child.kill('SIGKILL')
      throw new Error('Configurator did not become ready: ' + tail)
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  let closed: Promise<void> | undefined
  return Object.freeze({
    agentId: claim.agent_id,
    fingerprint: identity.fingerprint,
    assignments: Object.freeze(assignments),
    log: () => tail,
    close: () =>
      (closed ??= (async () => {
        const alive = () => child.exitCode === null && child.signalCode === null
        if (alive()) child.kill('SIGTERM')
        if (alive())
          await Promise.race([
            once(child, 'exit'),
            new Promise((resolve) => setTimeout(resolve, 8000)),
          ])
        if (alive()) {
          child.kill('SIGKILL')
          await once(child, 'exit')
        }
      })()),
  })
}
