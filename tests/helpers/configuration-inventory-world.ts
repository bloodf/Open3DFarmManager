import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { base64url } from '../../packages/farm-protocol/src/encoding.ts'
import { canonicalize } from '../../packages/farm-protocol/src/canonical.ts'
import {
  configurationBindingHash,
  type ConfigurationSessionBinding,
} from '../../packages/farm-protocol/src/configuration-binding.ts'
import {
  encodeConfigurationAdmissionProof,
  encodeConfigurationCapability,
  signConfigurationAdmissionProof,
  signConfigurationCapability,
} from '../../packages/farm-protocol/src/configuration-capability.ts'
import {
  configurationFrameTargetHash,
  type ConfigurationResponseFrame,
} from '../../packages/farm-protocol/src/configuration-frames.ts'
import {
  deriveConfigurationAssignmentIdentity,
  encodeConfigurationInventoryAck,
  signConfigurationInventoryAck,
} from '../../packages/farm-protocol/src/configuration-inventory.ts'
import {
  configurationReceiptHash,
  type SignedConfigurationReceipt,
} from '../../packages/farm-protocol/src/configuration-receipt.ts'
import { configurationTargetHash } from '../../packages/farm-protocol/src/configuration-target.ts'
import { readAgentRuntimeConfig } from '../../packages/connector/src/config/runtime.ts'
import { parseProvisioningConfig } from '../../packages/connector/src/config/provisioning.ts'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import type { KobraLinkFetch } from '../../packages/connector/src/kobralink/client.ts'
import { createRuntimeActivator } from '../../packages/connector/src/runtime/configuration-activation.ts'
import { createConfigurationIssuerSource } from '../../packages/connector/src/runtime/configuration-issuer.ts'
import { createConfigurationRuntime } from '../../packages/connector/src/runtime/configuration.ts'
import { encodeBrowserChannelMessage } from '../../packages/connector/src/webrtc/configuration-channel.ts'

/*
 * Shared synthetic world for the inventory-confirmation tests. The Connector
 * side (runtime, session, authority, engine, journal, activator, snapshot,
 * strict runtime reader, issuer source) is the real exported code. Synthetic
 * and mock-only: the KobraLink management service, the farm server's signing
 * (issuer and inventory acks use the accepted farm-protocol helpers exactly as
 * the server registration does) and the HTTPS issuer endpoint transport. No
 * real network, printer or shared engine.
 */
export const FARM_ORIGIN = 'https://farm.example.com'
export const AUDIENCE = 'open3dfarm/connector'
export const ISSUER = 'open3dfarm/config-issuer'
export const KID = 'config-issuer-1'
export const BRIDGE = 'http://127.0.0.1:7100'
export const T0 = 1_800_000_000_000
export const nonce = () => base64url(crypto.getRandomValues(new Uint8Array(32)))

export function syntheticBridge(lan: Record<string, string>) {
  const state = {
    needsSetup: true,
    users: [] as { email: string; password: string }[],
    tokens: new Set<string>(),
    printers: [] as { id: string; deviceId: string; ip: string }[],
    creates: 0,
  }
  const json = (value: unknown, status = 200, extra = {}) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json', ...extra },
    })
  const session = () => {
    const token = randomUUID()
    state.tokens.add(token)
    return json({}, 200, {
      'set-cookie': `better-auth.session_token=${token}; HttpOnly; Path=/`,
    })
  }
  const wire = (p: { id: string; deviceId: string; ip: string }) => ({
    ...p,
    name: 'Kobra X',
    username: 'mqtt-user-secret',
    model: 'Kobra X',
    live: null,
  })
  const fetch: KobraLinkFetch = async (url, init) => {
    const { pathname } = new URL(url)
    const method = init.method ?? 'GET'
    if (pathname === '/api/v1/setup/status')
      return json({ needsSetup: state.needsSetup })
    if (pathname === '/api/auth/sign-up/email') {
      const body = JSON.parse(String(init.body))
      state.users.push({ email: body.email, password: body.password })
      state.needsSetup = false
      return session()
    }
    if (pathname === '/api/auth/sign-in/email') {
      const body = JSON.parse(String(init.body))
      return state.users.some(
        (u) => u.email === body.email && u.password === body.password,
      )
        ? session()
        : json({}, 401)
    }
    const cookie = String(
      (init.headers as Record<string, string>).Cookie ?? '',
    ).split('=')[1]
    if (!cookie || !state.tokens.has(cookie)) return json({}, 401)
    if (pathname === '/api/v1/printers' && method === 'GET')
      return json(state.printers.map(wire))
    if (pathname === '/api/v1/printers' && method === 'POST') {
      const body = JSON.parse(String(init.body))
      const deviceId = lan[body.ip]
      if (!deviceId) return json({}, 503)
      state.creates++
      const created = {
        id: `p${state.printers.length + 1}`,
        deviceId,
        ip: body.ip,
      }
      state.printers.push(created)
      return json(wire(created))
    }
    return json({}, 404)
  }
  return { state, fetch }
}

export const dtlsOf = (seed: number) =>
  Array.from({ length: 32 }, () =>
    seed.toString(16).toUpperCase().padStart(2, '0'),
  ).join(':')
export const sdp = (seed: number) =>
  `v=0\r\na=fingerprint:sha-256 ${dtlsOf(seed)}\r\na=setup:actpass\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n`

export async function browserKey() {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const publicKey = { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! } as const
  const thumbprint = base64url(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(canonicalize(publicKey)),
      ),
    ),
  )
  return { pair, publicKey, thumbprint }
}
export type Browser = Awaited<ReturnType<typeof browserKey>>

export interface WorldOptions {
  /** Pre-existing confirmed Moonraker assignment in the committed runtime. */
  moonraker?: boolean
  lan?: Record<string, string>
}

/** Frames the browser sends (same shapes the accepted contract defines). */
export const target = (ip = '192.168.1.50') => ({
  v: 1,
  protocol: 'config-v1',
  backend: 'kobralink-anycubic',
  model: { family: 'anycubic-kobra-x', provisional: true },
  endpoint: { ipv4: ip, port: 18910 },
  bridge: { kind: 'connector-managed' },
})
export const frame = (
  type: string,
  operation_id: string,
  extra: Record<string, unknown>,
  revision = 0,
) => ({
  v: 1,
  protocol: 'config-v1',
  type,
  request_id: randomUUID(),
  operation_id,
  expected_revision: revision,
  ...extra,
})
export const prepareFrame = (op: string, ip?: string, revision = 0) =>
  frame('prepare', op, { target: target(ip) }, revision)
export async function commitFrame(
  op: string,
  prepared: ConfigurationResponseFrame,
  ip?: string,
  revision = 0,
) {
  if (prepared.type !== 'result') throw new Error('not prepared')
  return frame(
    'commit',
    op,
    {
      target_sha256: await configurationTargetHash(target(ip)),
      prepared_receipt_sha256: await configurationReceiptHash(prepared.receipt),
    },
    revision,
  )
}
export const statusFrame = async (op: string, ip?: string, revision = 0) =>
  frame(
    'status',
    op,
    { target_sha256: await configurationTargetHash(target(ip)) },
    revision,
  )

/** The one signature the server registration uses for the acknowledgement. */
export async function signInventoryAck(input: {
  issuerKey: CryptoKey
  binding: ConfigurationSessionBinding
  farm: string
  agent: string
  receipt: SignedConfigurationReceipt
  fingerprint: string
  now: number
  over?: Record<string, unknown>
}): Promise<string> {
  const { binding: b, receipt } = input
  const identity = await deriveConfigurationAssignmentIdentity({
    account_id: b.account_id,
    farm_id: input.farm,
    agent_id: input.agent,
    bridge_instance_id: receipt.target.bridge_instance_id,
    device_id: receipt.target.device_id,
  })
  return encodeConfigurationInventoryAck(
    await signConfigurationInventoryAck(
      {
        v: 1,
        protocol: 'config-v1',
        purpose: 'configuration-inventory-ack',
        context: {
          account_id: b.account_id,
          farm_id: input.farm,
          agent_id: input.agent,
          key_id: b.key_id,
          transport_id: b.transport_id,
          browser_thumbprint: b.browser_thumbprint,
          connector_fingerprint: input.fingerprint,
          credential_jti: b.credential_jti,
          configuration_binding_sha256: await configurationBindingHash(b),
          origin: FARM_ORIGIN,
          audience: AUDIENCE,
        },
        kid: KID,
        issuer: ISSUER,
        operation_id: receipt.operation_id,
        committed_receipt_sha256: await configurationReceiptHash(receipt),
        committed_revision: receipt.committed_revision,
        assignment_id: identity.assignment_id,
        printer_key: identity.printer_key,
        nonce: nonce(),
        issued_at: input.now,
        expires_at: input.now + 25_000,
        ...input.over,
      },
      input.issuerKey,
    ),
  )
}

/** Synthetic server issuance of one capability + admission proof. */
export async function authorizeFrame(input: {
  browser: Browser
  binding: ConfigurationSessionBinding
  farm: string
  agent: string
  fingerprint: string
  issuerKey: CryptoKey
  now: number
  frame: Record<string, unknown>
  over?: Record<string, unknown>
}) {
  const b = input.binding
  const common = {
    capability_id: randomUUID(),
    farm_id: input.farm,
    agent_id: input.agent,
    key_id: b.key_id,
    transport_id: b.transport_id,
    account_id: b.account_id,
    browser_thumbprint: input.browser.thumbprint,
    origin: FARM_ORIGIN,
    audience: AUDIENCE,
    configuration_binding_sha256: await configurationBindingHash(b),
    admission_nonce: nonce(),
    action: input.frame.type,
    operation_id: input.frame.operation_id,
    expected_revision: input.frame.expected_revision,
    target_sha256: await configurationFrameTargetHash(input.frame),
  }
  const admission = await signConfigurationAdmissionProof(
    {
      v: 1,
      purpose: 'configuration-admission',
      protocol: 'config-v1',
      challenge_id: randomUUID(),
      ...common,
      issued_at: input.now,
      expires_at: input.now + 8000,
    },
    input.browser.pair.privateKey,
  )
  const capability = await signConfigurationCapability(
    {
      v: 1,
      purpose: 'configuration-authority',
      protocol: 'config-v1',
      kid: KID,
      issuer: ISSUER,
      issued_at: input.now,
      expires_at: Math.min(input.now + 30_000, b.expires_at),
      role: 'owner',
      browser_public_key: input.browser.publicKey,
      connector_fingerprint: input.fingerprint,
      credential_jti: b.credential_jti,
      ...common,
      ...input.over,
    },
    input.issuerKey,
  )
  return {
    capability: encodeConfigurationCapability(capability),
    admission: encodeConfigurationAdmissionProof(admission),
  }
}

export async function createWorld(options: WorldOptions = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cfg-inventory-')))
  const ids = {
    farm: randomUUID(),
    agent: randomUUID(),
    key: randomUUID(),
    jti: randomUUID(),
  }
  const identity = new ConnectorIdentity(
    generateKeyPairSync('ed25519').privateKey,
  )
  const issuerKeys = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const publicJwk = await crypto.subtle.exportKey('jwk', issuerKeys.publicKey)
  const bridge = syntheticBridge(
    options.lan ?? {
      '192.168.1.50': 'kx-0001',
      '192.168.1.51': 'kx-0002',
    },
  )
  const runtimeConfigPath = join(dir, 'runtime.json')
  const moonrakerId = randomUUID()
  if (options.moonraker)
    writeFileSync(
      runtimeConfigPath,
      JSON.stringify({
        version: 1,
        collection: {
          version: 1,
          allowedOrigins: ['http://127.0.0.1:7125'],
          printers: [{ printerKey: 'voron', origin: 'http://127.0.0.1:7125' }],
        },
        assignments: [
          {
            assignment_id: moonrakerId,
            farm_id: ids.farm,
            agent_id: ids.agent,
            printer_key: 'voron',
            moonraker_origin: 'http://127.0.0.1:7125',
          },
        ],
        telemetry: { endpoint: FARM_ORIGIN + '/telemetry', audience: AUDIENCE },
      }),
      { mode: 0o600 },
    )
  const config = parseProvisioningConfig({
    version: 1,
    mode: 'configuration-provisioning',
    farm_id: ids.farm,
    agent_id: ids.agent,
    farmOrigin: FARM_ORIGIN,
    credentialAudience: AUDIENCE,
    stateDirectory: join(dir, 'state'),
    runtimeConfigPath,
    printerNetworks: ['192.168.1.0/24'],
    managedBridge: { origin: BRIDGE, ownership: 'connector-owned-fresh' },
    runtimeTemplate: {
      telemetry: {
        endpoint: FARM_ORIGIN + '/api/connector/telemetry',
        audience: AUDIENCE,
      },
    },
  })
  const env = {
    now: T0,
    online: true,
    jti: ids.jti as string | null,
    starts: 0,
    stops: 0,
    /** printer keys each collector start was given (the collection snapshot). */
    collected: [] as string[][],
    issuerOk: true,
    issuerRequests: [] as { url: string; init: RequestInit }[],
  }
  const runtimes: ReturnType<typeof createConfigurationRuntime>[] = []

  /** Exact public issuer metadata DTO, served over the (mock) HTTPS endpoint. */
  const issuerFetch = async (url: string, init: RequestInit) => {
    env.issuerRequests.push({ url, init })
    if (!env.issuerOk) return new Response('{}', { status: 503 })
    return new Response(
      JSON.stringify({
        protocol: 'config-v1',
        issuerKid: KID,
        origin: FARM_ORIGIN,
        audience: AUDIENCE,
        publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: publicJwk.x },
      }),
      { headers: { 'content-type': 'application/json' } },
    )
  }
  const activator = () =>
    createRuntimeActivator({
      runtimeConfigPath,
      scope: { agent_id: ids.agent, farm_id: ids.farm },
      snapshotPath: join(dir, 'state', 'collection-snapshot.json'),
      start: (signal, configPath) =>
        new Promise<void>((resolve) => {
          env.starts++
          env.collected.push(
            readAgentRuntimeConfig(configPath, {
              agent_id: ids.agent,
              farm_id: ids.farm,
            })
              .assignments.map((a) => a.printer_key)
              .sort(),
          )
          signal.addEventListener('abort', () => {
            env.stops++
            resolve()
          })
        }),
    })
  const boot = () => {
    const runtime = createConfigurationRuntime({
      identity,
      config,
      issuers: createConfigurationIssuerSource({
        farmOrigin: FARM_ORIGIN,
        fetch: issuerFetch,
        clock: () => env.now,
      }),
      activator: activator(),
      serverOnline: () => env.online,
      credentialJti: () => env.jti,
      clock: () => env.now,
      fetch: bridge.fetch,
    })
    runtimes.push(runtime)
    return runtime
  }

  async function binding(
    browser: Browser,
    over: Record<string, unknown> = {},
    seed = Math.floor(Math.random() * 200) + 20,
  ) {
    const offer = sdp(seed)
    const answer = sdp(seed + 1)
    const { controlSdpHash } =
      await import('../../packages/farm-protocol/src/control-session-binding.ts')
    const value = {
      v: 1,
      purpose: 'configuration-rtc',
      protocol: 'config-v1',
      transport_id: randomUUID(),
      farm_id: ids.farm,
      agent_id: ids.agent,
      account_id: 'account_owner',
      key_id: ids.key,
      browser_public_key: browser.publicKey,
      browser_thumbprint: browser.thumbprint,
      connector_public_key_spki: identity.publicKeySpki,
      connector_fingerprint: identity.fingerprint,
      credential_jti: ids.jti,
      origin: FARM_ORIGIN,
      audience: AUDIENCE,
      browser_nonce: nonce(),
      connector_nonce: nonce(),
      issued_at: env.now,
      expires_at: env.now + 30_000,
      offer_sha256: await controlSdpHash(offer),
      answer_sha256: await controlSdpHash(answer),
      browser_dtls: dtlsOf(seed + 1),
      connector_dtls: dtlsOf(seed),
      ...over,
    }
    return { value, offer, answer }
  }

  return {
    dir,
    ids,
    identity,
    issuerKeys,
    config,
    env,
    bridge,
    boot,
    binding,
    issuerFetch,
    runtimeConfigPath,
    moonrakerId,
    /** Collection snapshot published for the latest start (state-private). */
    snapshotPath: join(dir, 'state', 'collection-snapshot.json'),
    readRuntimeFile: () => JSON.parse(readFileSync(runtimeConfigPath, 'utf8')),
    async cleanup() {
      for (const runtime of runtimes.splice(0)) await runtime.shutdown()
      rmSync(dir, { recursive: true, force: true })
    },
    ack: (
      t: { binding: ConfigurationSessionBinding },
      receipt: SignedConfigurationReceipt,
      over?: Record<string, unknown>,
      issuerKey: CryptoKey = issuerKeys.privateKey,
    ) =>
      signInventoryAck({
        issuerKey,
        binding: t.binding,
        farm: ids.farm,
        agent: ids.agent,
        receipt,
        fingerprint: identity.fingerprint,
        now: env.now,
        ...(over ? { over } : {}),
      }),
    authorize: (
      browser: Browser,
      b: ConfigurationSessionBinding,
      f: Record<string, unknown>,
      over?: Record<string, unknown>,
    ) =>
      authorizeFrame({
        browser,
        binding: b,
        farm: ids.farm,
        agent: ids.agent,
        fingerprint: identity.fingerprint,
        issuerKey: issuerKeys.privateKey,
        now: env.now,
        frame: f,
        ...(over ? { over } : {}),
      }),
    inventoryMessage: async (
      receipt: SignedConfigurationReceipt,
      attestation: string,
      over: Record<string, unknown> = {},
    ) =>
      encodeBrowserChannelMessage({
        v: 1,
        t: 'inventory',
        operation_id: receipt.operation_id,
        local_committed_receipt_sha256: await configurationReceiptHash(receipt),
        committed_revision: receipt.committed_revision,
        attestation,
        ...over,
      }),
  }
}
export type World = Awaited<ReturnType<typeof createWorld>>
