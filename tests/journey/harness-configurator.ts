// The journey's second Connector: a paired, approved Connector in
// configuration mode (no printers), so the Impressoras page can open its
// config-v1 session and search for printers. The search answers with the
// loopback discovery responders of the vendor simulators; everything else is
// the real `configure` runtime in its own process.
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
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

export type Configurator = Readonly<{
  agentId: string
  fingerprint: string
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
  probes: Readonly<{ creality?: number; anycubic?: number }>
}): Promise<Configurator> {
  const root = await mkdtemp(join(tmpdir(), 'journey-configurator-'))
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
      runtimeConfigPath: join(root, 'runtime.json'),
      printerNetworks: ['172.30.78.0/24'],
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
  const collect = (chunk: Buffer) => {
    tail = (tail + chunk.toString('utf8')).slice(-8192)
  }
  const child: ChildProcess = spawn(
    process.execPath,
    [new URL('./configurator-child.ts', import.meta.url).pathname],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        NODE_OPTIONS: '',
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
  while (!tail.includes('"configuration-signalling","state":"ready"')) {
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
