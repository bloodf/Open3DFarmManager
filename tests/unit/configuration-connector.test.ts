import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
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
import { controlSdpHash } from '../../packages/farm-protocol/src/control-session-binding.ts'
import {
  configurationBindingHash,
  encodeConfigurationSessionProof,
  signConfigurationSessionProof,
} from '../../packages/farm-protocol/src/configuration-binding.ts'
import {
  encodeConfigurationAdmissionProof,
  encodeConfigurationCapability,
  signConfigurationAdmissionProof,
  signConfigurationCapability,
} from '../../packages/farm-protocol/src/configuration-capability.ts'
import {
  configurationFrameTargetHash,
  decodeConfigurationResponse,
  encodeConfigurationRequest,
  type ConfigurationResponseFrame,
} from '../../packages/farm-protocol/src/configuration-frames.ts'
import {
  configurationReceiptHash,
  decodeConfigurationReceipt,
  verifyConfigurationReceipt,
  type SignedConfigurationReceipt,
} from '../../packages/farm-protocol/src/configuration-receipt.ts'
import { configurationTargetHash } from '../../packages/farm-protocol/src/configuration-target.ts'
import {
  deriveConfigurationAssignmentIdentity,
  encodeConfigurationInventoryAck,
  signConfigurationInventoryAck,
} from '../../packages/farm-protocol/src/configuration-inventory.ts'
import { encodeConfigurationSignallingServerFrame } from '../../packages/farm-protocol/src/configuration-signalling.ts'
import { readAgentRuntimeConfig } from '../../packages/connector/src/config/runtime.ts'
import { parseProvisioningConfig } from '../../packages/connector/src/config/provisioning.ts'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import type { KobraLinkFetch } from '../../packages/connector/src/kobralink/client.ts'
import { createRuntimeActivator } from '../../packages/connector/src/runtime/configuration-activation.ts'
import {
  createConfigurationIssuerSource,
  fixedConfigurationIssuer,
  trustedIssuerFromMetadata,
} from '../../packages/connector/src/runtime/configuration-issuer.ts'
import {
  createConfigurationRuntime,
  type ConfigurationRuntime,
} from '../../packages/connector/src/runtime/configuration.ts'
import {
  decodeConnectorChannelMessage,
  encodeBrowserChannelMessage,
} from '../../packages/connector/src/webrtc/configuration-channel.ts'
import type { ConfigurationConnectorSession } from '../../packages/connector/src/webrtc/configuration-session.ts'
import {
  createConfigurationSignallingClient,
  type ConfigurationPeerFactory,
  type ConfigurationSocket,
} from '../../packages/connector/src/webrtc/configuration-signalling.ts'

/*
 * MOCK-ONLY synthetic boundaries: an in-memory KobraLink management service
 * (original, contract-shaped), a synthetic config-v1 issuer that signs with
 * the accepted protocol primitives, synthetic SDP/DTLS descriptions and a
 * synthetic signalling socket. The Connector side is the real exported
 * runtime, session, authority, engine, journal and runtime reader.
 * No network, no printer, no shared engine.
 */
const FARM_ORIGIN = 'https://farm.example.com'
const AUDIENCE = 'open3dfarm/connector'
const BRIDGE = 'http://127.0.0.1:7100'
const KID = 'config-issuer-1'
const T0 = 1_800_000_000_000

function syntheticBridge(lan: Record<string, string>) {
  const state = {
    needsSetup: true,
    users: [] as { email: string; password: string }[],
    tokens: new Set<string>(),
    printers: [] as { id: string; deviceId: string; ip: string }[],
    creates: 0,
    down: false,
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
    if (state.down) throw new Error('bridge down')
    const { pathname } = new URL(url)
    const method = init.method ?? 'GET'
    if (pathname === '/api/v1/setup/status')
      return json({ needsSetup: state.needsSetup })
    if (pathname === '/api/auth/sign-up/email') {
      if (!state.needsSetup) return json({}, 403)
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
    const match = /^\/api\/v1\/printers\/([A-Za-z0-9_-]+)$/.exec(pathname)
    const found = state.printers.find((p) => p.id === match?.[1])
    if (found && method === 'GET') return json(wire(found))
    if (found && method === 'DELETE') {
      state.printers = state.printers.filter((p) => p !== found)
      return new Response(null, { status: 204 })
    }
    return json({}, 404)
  }
  return { state, fetch }
}

const dtlsOf = (seed: number) =>
  Array.from({ length: 32 }, () =>
    seed.toString(16).toUpperCase().padStart(2, '0'),
  ).join(':')
const sdp = (seed: number) =>
  `v=0\r\na=fingerprint:sha-256 ${dtlsOf(seed)}\r\na=setup:actpass\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n`
const nonce = () => base64url(crypto.getRandomValues(new Uint8Array(32)))

async function browserKey() {
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
type Browser = Awaited<ReturnType<typeof browserKey>>

const realFetch = globalThis.fetch
let networkAttempts = 0
const dirs: string[] = []
const runtimes: ConfigurationRuntime[] = []
beforeEach(() => {
  networkAttempts = 0
  globalThis.fetch = (async () => {
    networkAttempts++
    throw new Error('real network forbidden')
  }) as typeof fetch
})
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.shutdown()
  globalThis.fetch = realFetch
  expect(networkAttempts).toBe(0)
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

async function world(
  options: {
    runtimeFile?: 'absent' | 'moonraker'
    template?: Record<string, unknown>
  } = {},
) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cfg-connector-')))
  dirs.push(dir)
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
  const issuer = fixedConfigurationIssuer({
    kid: KID,
    origin: FARM_ORIGIN,
    audience: AUDIENCE,
    key: issuerKeys.publicKey,
  })
  const bridge = syntheticBridge({ '192.168.1.50': 'kx-0001' })
  const runtimeConfigPath = join(dir, 'runtime.json')
  if (options.runtimeFile === 'moonraker')
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
            assignment_id: randomUUID(),
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
    runtimeTemplate: options.template ?? {
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
    /** Runtime file each start received (the collection snapshot). */
    startedFrom: [] as string[],
  }
  const activator = () =>
    createRuntimeActivator({
      runtimeConfigPath,
      scope: { agent_id: ids.agent, farm_id: ids.farm },
      snapshotPath: join(dir, 'state', 'collection-snapshot.json'),
      start: (signal, configPath) =>
        new Promise<void>((resolve) => {
          env.starts++
          env.startedFrom.push(configPath)
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
      issuers: issuer,
      activator: activator(),
      serverOnline: () => env.online,
      credentialJti: () => env.jti,
      clock: () => env.now,
      fetch: bridge.fetch,
    })
    runtimes.push(runtime)
    return runtime
  }

  let seed = 1
  /** Synthetic server: issues one binding for a fresh transport (<=30 s). */
  async function binding(browser: Browser, over: Record<string, unknown> = {}) {
    const a = ++seed
    const b = ++seed
    const offer = sdp(a)
    const answer = sdp(b)
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
      browser_dtls: dtlsOf(b),
      connector_dtls: dtlsOf(a),
      ...over,
    }
    return { value, offer, answer }
  }

  /** Synthetic browser on one authenticated transport. */
  async function connect(
    runtime: ConfigurationRuntime,
    browser: Browser,
    over: Record<string, unknown> = {},
    expectedOver: Record<string, unknown> = {},
  ) {
    const issued = await binding(browser, over)
    const b = issued.value
    const inbox: ReturnType<typeof decodeConnectorChannelMessage>[] = []
    let wake: () => void = () => {}
    const session: ConfigurationConnectorSession = runtime.openSession({
      expected: {
        transportId: b.transport_id as string,
        farmId: ids.farm,
        agentId: ids.agent,
        accountId: b.account_id as string,
        keyId: b.key_id as string,
        browserThumbprint: browser.thumbprint,
        credentialJti: ids.jti,
        connectorNonce: b.connector_nonce as string,
        ...expectedOver,
      },
      send: (wire) => {
        inbox.push(decodeConnectorChannelMessage(wire))
        wake()
      },
    })
    const next = async () => {
      for (let i = 0; i < 200 && inbox.length === 0; i++) {
        if (session.state === 'closed') break
        await new Promise<void>((resolve) => {
          wake = resolve
          setTimeout(resolve, 10)
        })
      }
      return inbox.shift()
    }
    await session.activate(
      b,
      { localSdp: issued.offer, remoteSdp: issued.answer },
      b.browser_dtls as string,
    )
    const connectorProof = await next()
    if (connectorProof?.t === 'proof') {
      const signature = await signConfigurationSessionProof(
        b,
        'browser',
        browser.pair.privateKey,
      )
      session.receive(
        encodeBrowserChannelMessage({
          v: 1,
          t: 'proof',
          proof: encodeConfigurationSessionProof({
            v: 1,
            role: 'browser',
            binding: b,
            signature,
          }),
        }),
      )
      for (let i = 0; i < 100 && session.state !== 'authenticated'; i++)
        await new Promise((resolve) => setTimeout(resolve, 5))
    }

    /** Synthetic server issuance (admission challenge + capability). */
    async function authorize(
      frame: Record<string, unknown>,
      capOver: Record<string, unknown> = {},
    ) {
      const targetSha = await configurationFrameTargetHash(frame)
      const bindingSha = await configurationBindingHash(b)
      const admissionNonce = nonce()
      const capabilityId = randomUUID()
      const common = {
        capability_id: capabilityId,
        farm_id: ids.farm,
        agent_id: ids.agent,
        key_id: b.key_id,
        transport_id: b.transport_id,
        account_id: b.account_id,
        browser_thumbprint: browser.thumbprint,
        origin: FARM_ORIGIN,
        audience: AUDIENCE,
        configuration_binding_sha256: bindingSha,
        admission_nonce: admissionNonce,
        action: frame.type,
        operation_id: frame.operation_id,
        expected_revision: frame.expected_revision,
        target_sha256: targetSha,
      }
      const admission = await signConfigurationAdmissionProof(
        {
          v: 1,
          purpose: 'configuration-admission',
          protocol: 'config-v1',
          challenge_id: randomUUID(),
          ...common,
          issued_at: env.now,
          expires_at: env.now + 8000,
        },
        browser.pair.privateKey,
      )
      const capability = await signConfigurationCapability(
        {
          v: 1,
          purpose: 'configuration-authority',
          protocol: 'config-v1',
          kid: KID,
          issuer: 'open3dfarm/config-issuer',
          issued_at: env.now,
          expires_at: Math.min(env.now + 30_000, b.expires_at as number),
          role: 'owner',
          browser_public_key: browser.publicKey,
          connector_fingerprint: identity.fingerprint,
          credential_jti: b.credential_jti,
          ...common,
          ...capOver,
        },
        issuerKeys.privateKey,
      )
      return {
        capability: encodeConfigurationCapability(capability),
        admission: encodeConfigurationAdmissionProof(admission),
      }
    }

    async function request(
      frame: Record<string, unknown>,
      capOver: Record<string, unknown> = {},
      reuse?: { capability: string; admission: string },
    ): Promise<ConfigurationResponseFrame | undefined> {
      const auth = reuse ?? (await authorize(frame, capOver))
      session.receive(
        encodeBrowserChannelMessage({
          v: 1,
          t: 'request',
          frame: encodeConfigurationRequest(frame),
          ...auth,
        }),
      )
      const message = await next()
      if (message?.t !== 'response') return undefined
      return decodeConfigurationResponse(message.frame)
    }
    return { session, binding: b, authorize, request, next, inbox }
  }

  /**
   * Server-signed inventory acknowledgement, built exactly like the accepted
   * server registration (same helpers, same context fields) for a transport.
   */
  async function inventoryAck(
    t: { binding: Record<string, unknown> },
    receipt: SignedConfigurationReceipt,
    over: Record<string, unknown> = {},
    key: CryptoKey = issuerKeys.privateKey,
  ): Promise<string> {
    const b = t.binding
    const identity = await deriveConfigurationAssignmentIdentity({
      account_id: b.account_id,
      farm_id: ids.farm,
      agent_id: ids.agent,
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
            farm_id: ids.farm,
            agent_id: ids.agent,
            key_id: b.key_id,
            transport_id: b.transport_id,
            browser_thumbprint: b.browser_thumbprint,
            connector_fingerprint: identity_fingerprint(),
            credential_jti: b.credential_jti,
            configuration_binding_sha256: await configurationBindingHash(b),
            origin: FARM_ORIGIN,
            audience: AUDIENCE,
          },
          kid: KID,
          issuer: 'open3dfarm/config-issuer',
          operation_id: receipt.operation_id,
          committed_receipt_sha256: await configurationReceiptHash(receipt),
          committed_revision: receipt.committed_revision,
          assignment_id: identity.assignment_id,
          printer_key: identity.printer_key,
          nonce: nonce(),
          issued_at: env.now,
          expires_at: env.now + 25_000,
          ...over,
        },
        key,
      ),
    )
  }
  const identity_fingerprint = () => identity.fingerprint
  /** Browser inventory message for a committed receipt with a signed ack. */
  async function inventoryMessage(
    t: { binding: Record<string, unknown> },
    receipt: SignedConfigurationReceipt,
    attestation?: string,
    over: Record<string, unknown> = {},
  ) {
    return encodeBrowserChannelMessage({
      v: 1,
      t: 'inventory',
      operation_id: receipt.operation_id,
      local_committed_receipt_sha256: await configurationReceiptHash(receipt),
      committed_revision: receipt.committed_revision,
      attestation: attestation ?? (await inventoryAck(t, receipt)),
      ...over,
    })
  }

  const target = (ip = '192.168.1.50') => ({
    v: 1,
    protocol: 'config-v1',
    backend: 'kobralink-anycubic',
    model: { family: 'anycubic-kobra-x', provisional: true },
    endpoint: { ipv4: ip, port: 18910 },
    bridge: { kind: 'connector-managed' },
  })
  const frame = (
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
  const prepareFrame = (op: string, ip?: string) =>
    frame('prepare', op, { target: target(ip) })
  const commitFrame = async (
    op: string,
    prepared: ConfigurationResponseFrame,
  ) => {
    if (prepared.type !== 'result') throw new Error('not prepared')
    return frame('commit', op, {
      target_sha256: await configurationTargetHash(target()),
      prepared_receipt_sha256: await configurationReceiptHash(prepared.receipt),
    })
  }
  const statusFrame = async (op: string) =>
    frame('status', op, {
      target_sha256: await configurationTargetHash(target()),
    })
  return {
    dir,
    ids,
    identity,
    config,
    env,
    bridge,
    boot,
    connect,
    frame,
    target,
    prepareFrame,
    commitFrame,
    statusFrame,
    inventoryAck,
    inventoryMessage,
    runtimeConfigPath,
  }
}

describe('configuration-connector: zero-printer bootstrap to activation', () => {
  it('empty bootstrap -> authenticated prepare -> commit -> receipt ack -> runtime activation', async () => {
    const w = await world()
    const runtime = w.boot()
    expect(await runtime.start()).toEqual({ pendingInventory: 0 })
    expect(existsSync(w.runtimeConfigPath)).toBe(false)
    expect(w.env.starts).toBe(0)

    const browser = await browserKey()
    const t = await w.connect(runtime, browser)
    expect(t.session.state).toBe('authenticated')
    const op = randomUUID()
    const prepared = await t.request(w.prepareFrame(op))
    expect(prepared?.type).toBe('result')
    if (prepared?.type !== 'result') throw new Error('prepare failed')
    expect(prepared.state).toBe('prepared')
    expect(
      await verifyConfigurationReceipt(
        prepared.receipt,
        await crypto.subtle.importKey(
          'spki',
          Buffer.from(w.identity.publicKeySpki, 'base64url'),
          { name: 'Ed25519' },
          true,
          ['verify'],
        ),
      ),
    ).toBe(true)
    expect(w.bridge.state.creates).toBe(1)
    expect(existsSync(w.runtimeConfigPath)).toBe(false)

    const committed = await t.request(await w.commitFrame(op, prepared))
    if (committed?.type !== 'result') throw new Error('commit failed')
    expect(committed.state).toBe('local-committed')
    // Server-expected chaining (configuration-server registration).
    expect(committed.receipt.prior_receipt_sha256).toBe(
      await configurationReceiptHash(prepared.receipt),
    )
    expect(committed.receipt.target.target_sha256).toBe(
      await configurationTargetHash(w.target()),
    )
    expect(committed.receipt.committed_revision).toBe(1)
    const runtimeConfig = readAgentRuntimeConfig(w.runtimeConfigPath, {
      agent_id: w.ids.agent,
      farm_id: w.ids.farm,
    })
    expect(runtimeConfig.assignments).toHaveLength(1)
    // A new unconfirmed assignment never starts collecting by itself.
    expect(w.env.starts).toBe(0)
    expect(runtime.diagnostics().runtimeActive).toBe(false)
    const raw = readFileSync(w.runtimeConfigPath, 'utf8')
    expect(raw).not.toContain('password')

    t.session.receive(await w.inventoryMessage(t, committed.receipt))
    const ack = await t.next()
    expect(ack?.t).toBe('inventory-result')
    if (ack?.t !== 'inventory-result') throw new Error('no ack')
    expect(ack.ok).toBe(true)
    expect(decodeConfigurationReceipt(ack.receipt).phase).toBe(
      'inventory-confirmed',
    )
    // Durable authenticated confirmation starts the collector exactly once.
    expect(w.env.starts).toBe(1)
    expect(runtime.diagnostics().runtimeActive).toBe(true)
    expect(await runtime.engine.pendingInventoryConfirmations()).toEqual([])
    expect(runtime.revision()).toBe(1)
  })

  it('preserves other printers and configuration when adding the first KobraLink printer', async () => {
    const w = await world({ runtimeFile: 'moonraker' })
    const runtime = w.boot()
    await runtime.start()
    expect(w.env.starts).toBe(1)
    const t = await w.connect(runtime, await browserKey())
    const op = randomUUID()
    const prepared = await t.request(w.prepareFrame(op))
    const committed = await t.request(await w.commitFrame(op, prepared!))
    expect(committed?.type === 'result' && committed.state).toBe(
      'local-committed',
    )
    const config = readAgentRuntimeConfig(w.runtimeConfigPath, {
      agent_id: w.ids.agent,
      farm_id: w.ids.farm,
    })
    const kobra = config.assignments.find((a) => a.printer_key !== 'voron')
    expect(kobra?.printer_key).toMatch(/^kobra-x-[A-Za-z0-9_-]{43}$/)
    expect(config.assignments.map((a) => a.printer_key)).toContain('voron')
    expect(config.telemetry.endpoint).toBe(FARM_ORIGIN + '/telemetry')
    // The existing confirmed Moonraker collector keeps running untouched while
    // the new assignment waits for its authenticated confirmation.
    expect(w.env.starts).toBe(1)
    expect(w.env.stops).toBe(0)
    if (committed?.type !== 'result') throw new Error('commit failed')
    t.session.receive(await w.inventoryMessage(t, committed.receipt))
    expect(await t.next()).toMatchObject({ t: 'inventory-result', ok: true })
    expect(w.env.starts).toBe(2)
    expect(w.env.stops).toBe(1)
  })

  it('a failed config apply leaves no runtime and never activates', async () => {
    const w = await world({ template: { telemetry: { endpoint: 7 } } })
    const runtime = w.boot()
    await runtime.start()
    const t = await w.connect(runtime, await browserKey())
    const op = randomUUID()
    const prepared = await t.request(w.prepareFrame(op))
    expect(prepared?.type).toBe('result')
    const committed = await t.request(await w.commitFrame(op, prepared!))
    expect(committed).toMatchObject({ type: 'error', code: 'not-available' })
    expect(existsSync(w.runtimeConfigPath)).toBe(false)
    expect(w.env.starts).toBe(0)
  })
})

describe('configuration-connector: human-time boundary and reauthentication', () => {
  it('late commit after binding expiry needs a fresh transport; same owner/key reconciles without repeating create', async () => {
    const w = await world()
    const runtime = w.boot()
    await runtime.start()
    const browser = await browserKey()
    const a = await w.connect(runtime, browser)
    const op = randomUUID()
    const prepared = await a.request(w.prepareFrame(op))
    expect(prepared?.type === 'result' && prepared.state).toBe('prepared')

    // Capability issued while the binding was live, presented after the
    // owner read the screen for longer than the 30 s binding.
    const commit = await w.commitFrame(op, prepared!)
    const stale = await a.authorize(commit)
    w.env.now += 31_000
    const late = await a.request(commit, {}, stale)
    expect(late).toMatchObject({ type: 'error', code: 'expired' })
    a.session.close('binding-expired')

    // Fresh RTC session for the same stable owner, browser key and Connector.
    const b = await w.connect(runtime, browser)
    expect(b.binding.transport_id).not.toBe(a.binding.transport_id)
    const status = await b.request(await w.statusFrame(op))
    expect(status?.type === 'result' && status.state).toBe('prepared')
    const committed = await b.request(await w.commitFrame(op, prepared!))
    expect(committed?.type === 'result' && committed.state).toBe(
      'local-committed',
    )
    expect(w.bridge.state.creates).toBe(1)
    expect(w.env.starts).toBe(0)
  })

  it('cross-owner, other browser key and revoked credential stay rejected on a new transport', async () => {
    const w = await world()
    const runtime = w.boot()
    await runtime.start()
    const browser = await browserKey()
    const a = await w.connect(runtime, browser)
    const op = randomUUID()
    const prepared = await a.request(w.prepareFrame(op))
    a.session.close('done')
    w.env.now += 40_000

    // Different account (another admin of the same farm).
    const other = await w.connect(runtime, browser, {
      account_id: 'account_admin',
    })
    expect(other.session.state).toBe('authenticated')
    expect(
      await other.request(await w.commitFrame(op, prepared!)),
    ).toMatchObject({ type: 'error', code: 'capability-rejected' })
    other.session.close('done')

    // Different (e.g. revoked and re-enrolled) browser device key.
    const otherKey = await browserKey()
    const keyed = await w.connect(runtime, otherKey, { key_id: randomUUID() })
    expect(
      await keyed.request(await w.commitFrame(op, prepared!)),
    ).toMatchObject({ type: 'error', code: 'capability-rejected' })
    keyed.session.close('done')

    // Connector credential replaced: a binding for the old JTI is refused.
    const owner = await w.connect(runtime, browser)
    w.env.jti = randomUUID()
    expect(
      await owner.request(await w.commitFrame(op, prepared!)),
    ).toMatchObject({ type: 'error', code: 'capability-rejected' })
    expect(w.bridge.state.creates).toBe(1)
    expect(existsSync(w.runtimeConfigPath)).toBe(false)
  })
})

describe('configuration-connector: authority, replay and recovery', () => {
  it('server outage refuses configuration writes before any bridge call', async () => {
    const w = await world()
    const runtime = w.boot()
    await runtime.start()
    const t = await w.connect(runtime, await browserKey())
    w.env.online = false
    const response = await t.request(w.prepareFrame(randomUUID()))
    expect(response).toMatchObject({
      type: 'error',
      code: 'capability-rejected',
    })
    expect(w.bridge.state.creates).toBe(0)
    expect(w.bridge.state.needsSetup).toBe(true)
  })

  it('rejects expired, foreign-issuer, wrong-context and replayed capabilities', async () => {
    const w = await world()
    const runtime = w.boot()
    await runtime.start()
    const t = await w.connect(runtime, await browserKey())
    const op = randomUUID()
    const prepare = w.prepareFrame(op)

    expect(
      await t.request(prepare, {
        expires_at: w.env.now - 1,
        issued_at: w.env.now - 2000,
      }),
    ).toMatchObject({ type: 'error', code: 'expired' })
    expect(await t.request(prepare, { kid: 'rotated-unknown' })).toMatchObject({
      type: 'error',
      code: 'capability-rejected',
    })
    expect(
      await t.request(prepare, { role: 'owner', farm_id: randomUUID() }),
    ).toMatchObject({ type: 'error', code: 'capability-rejected' })
    // Capability for a different operation than the frame.
    expect(
      await t.request(prepare, { operation_id: randomUUID() }),
    ).toMatchObject({ type: 'error', code: 'capability-rejected' })

    const auth = await t.authorize(prepare)
    const first = await t.request(prepare, {}, auth)
    expect(first?.type === 'result' && first.state).toBe('prepared')
    // Exact replay of the consumed capability.
    expect(await t.request(prepare, {}, auth)).toMatchObject({
      type: 'error',
      code: 'capability-rejected',
    })
    // Fresh capability, same request id but a different frame body.
    const altered = { ...prepare, expected_revision: 1 }
    expect(await t.request(altered)).toMatchObject({ type: 'error' })
    // Fresh capability, identical frame: idempotent durable answer.
    const again = await t.request(prepare)
    expect(again?.type === 'result' && again.state).toBe('prepared')
    expect(w.bridge.state.creates).toBe(1)
  })

  it('rejects a binding for another Connector context or an untrusted DTLS pin', async () => {
    const w = await world()
    const runtime = w.boot()
    await runtime.start()
    const browser = await browserKey()
    const foreign = await w.connect(
      runtime,
      browser,
      {},
      { agentId: randomUUID() },
    )
    expect(foreign.session.state).toBe('closed')
    expect(foreign.session.terminalReason).toBe('binding-rejected')
    const replayNonce = await w.connect(
      runtime,
      browser,
      {},
      {
        connectorNonce: nonce(),
      },
    )
    expect(replayNonce.session.state).toBe('closed')
    expect(runtime.diagnostics().openTransports).toBe(0)
  })

  it('closes on malformed, oversize, deep or out-of-order channel messages', async () => {
    const w = await world()
    const runtime = w.boot()
    await runtime.start()
    const browser = await browserKey()
    for (const raw of [
      '{"v":1,"t":"request"}',
      'x'.repeat(50_000),
      JSON.stringify({ v: 1, t: 'proof', proof: { a: { b: { c: 1 } } } }),
      ' {"v":1,"t":"proof","proof":"x"}',
      42,
    ]) {
      const t = await w.connect(runtime, browser)
      expect(t.session.state).toBe('authenticated')
      t.session.receive(raw)
      expect(t.session.state).toBe('closed')
      expect(t.session.terminalReason).toBe('protocol-violation')
    }
    // A second proof after authentication is out of order.
    const t = await w.connect(runtime, browser)
    t.session.receive(
      encodeBrowserChannelMessage({ v: 1, t: 'proof', proof: 'x' }),
    )
    await t.session.closed
    expect(t.session.terminalReason).toBe('protocol-violation')
    expect(runtime.diagnostics().openTransports).toBe(0)
  })

  it('lost acknowledgement and restart reuse the journal and never repeat creation', async () => {
    const w = await world()
    const first = w.boot()
    await first.start()
    const browser = await browserKey()
    const t = await w.connect(first, browser)
    const op = randomUUID()
    const prepared = await t.request(w.prepareFrame(op))
    const commit = await w.commitFrame(op, prepared!)
    // Response lost in transit: the browser never sees it.
    const lost = await t.request(commit)
    expect(lost?.type === 'result' && lost.state).toBe('local-committed')
    await first.shutdown()
    expect(w.env.stops).toBe(0)

    // Connector restarts; the browser reconnects on a new transport. The only
    // assignment is still unconfirmed, so nothing collects yet.
    w.env.now += 60_000
    const second = w.boot()
    expect(await second.start()).toEqual({ pendingInventory: 1 })
    expect(w.env.starts).toBe(0)
    const u = await w.connect(second, browser)
    const retried = await u.request({ ...commit, request_id: randomUUID() })
    expect(retried?.type === 'result' && retried.state).toBe('local-committed')
    const status = await u.request(await w.statusFrame(op))
    expect(status?.type === 'result' && status.receipt.receipt_id).toBe(
      lost?.type === 'result' && lost.receipt.receipt_id,
    )
    expect(w.bridge.state.creates).toBe(1)
    expect(w.bridge.state.printers).toHaveLength(1)
  })

  it('inventory acknowledgement fails closed unless the server-signed ack verifies', async () => {
    const w = await world()
    const runtime = w.boot()
    await runtime.start()
    const t = await w.connect(runtime, await browserKey())
    const op = randomUUID()
    const prepared = await t.request(w.prepareFrame(op))
    const committed = await t.request(await w.commitFrame(op, prepared!))
    if (committed?.type !== 'result') throw new Error('commit failed')
    const receipt = committed.receipt
    const wrongKey = await crypto.subtle.generateKey('Ed25519', false, ['sign'])
    for (const [attestation, over, expected] of [
      ['forged', {}, 'rejected'],
      [
        await w.inventoryAck(t, receipt, {}, wrongKey.privateKey),
        {},
        'rejected',
      ],
      [await w.inventoryAck(t, receipt, { kid: 'other-kid' }), {}, 'rejected'],
      [
        await w.inventoryAck(t, receipt, { issuer: 'open3dfarm/foreign' }),
        {},
        'rejected',
      ],
      [
        await w.inventoryAck(t, receipt, {
          printer_key: 'kobra-x-' + 'A'.repeat(42) + 'A',
        }),
        {},
        'rejected',
      ],
      [
        await w.inventoryAck(t, receipt, { assignment_id: randomUUID() }),
        {},
        'rejected',
      ],
      [
        await w.inventoryAck(t, receipt, { operation_id: randomUUID() }),
        {},
        'rejected',
      ],
      [
        await w.inventoryAck(t, receipt, {
          committed_receipt_sha256: nonce(),
        }),
        {},
        'rejected',
      ],
      [
        await w.inventoryAck(t, receipt, {
          issued_at: w.env.now - 40_000,
          expires_at: w.env.now - 10_000,
        }),
        {},
        'rejected',
      ],
      [undefined, { committed_revision: 2 }, 'mismatch'],
    ] as const) {
      t.session.receive(await w.inventoryMessage(t, receipt, attestation, over))
      expect(await t.next()).toMatchObject({ ok: false, reason: expected })
    }
    // Another transport's acknowledgement is bound to its own context.
    const other = await w.connect(runtime, await browserKey())
    const foreignAck = await w.inventoryAck(other, receipt)
    t.session.receive(await w.inventoryMessage(t, receipt, foreignAck))
    expect(await t.next()).toMatchObject({ ok: false, reason: 'rejected' })
    expect(await runtime.engine.pendingInventoryConfirmations()).toHaveLength(1)
    expect(w.env.starts).toBe(0)
    // Server outage refuses even a genuine acknowledgement.
    w.env.online = false
    t.session.receive(await w.inventoryMessage(t, receipt))
    expect(await t.next()).toMatchObject({ ok: false, reason: 'rejected' })
    w.env.online = true
    t.session.receive(await w.inventoryMessage(t, receipt))
    expect(await t.next()).toMatchObject({ ok: true })
    expect(w.env.starts).toBe(1)
  })

  it('shutdown closes sessions, revokes authority and stops the runtime', async () => {
    const w = await world({ runtimeFile: 'moonraker' })
    const runtime = w.boot()
    await runtime.start()
    const t = await w.connect(runtime, await browserKey())
    expect(runtime.diagnostics()).toMatchObject({
      sessions: 1,
      openTransports: 1,
      runtimeActive: true,
    })
    await runtime.shutdown()
    expect(t.session.state).toBe('closed')
    expect(runtime.diagnostics()).toMatchObject({
      sessions: 0,
      openTransports: 0,
      admittedCapabilities: 0,
      runtimeActive: false,
    })
    expect(w.env.stops).toBe(1)
    expect(() =>
      runtime.openSession({
        expected: t.session as never,
        send: () => {},
      }),
    ).toThrow()
  })
})

describe('configuration-connector: issuer metadata and signalling', () => {
  it('accepts only exact issuer metadata from the pinned farm origin', async () => {
    const keys = await crypto.subtle.generateKey('Ed25519', true, [
      'sign',
      'verify',
    ])
    const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
    const metadata = {
      protocol: 'config-v1',
      issuerKid: KID,
      origin: FARM_ORIGIN,
      audience: AUDIENCE,
      publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x },
    }
    const issuer = await trustedIssuerFromMetadata(metadata, FARM_ORIGIN)
    expect(issuer.kid).toBe(KID)
    await expect(
      trustedIssuerFromMetadata(metadata, 'https://evil.example'),
    ).rejects.toThrow()
    await expect(
      trustedIssuerFromMetadata(
        {
          ...metadata,
          publicKeyJwk: { ...metadata.publicKeyJwk, crv: 'X25519' },
        },
        FARM_ORIGIN,
      ),
    ).rejects.toThrow()
    await expect(
      trustedIssuerFromMetadata({ ...metadata, extra: 1 }, FARM_ORIGIN),
    ).rejects.toThrow()

    const requests: { url: string; init: RequestInit }[] = []
    let now = 0
    const source = createConfigurationIssuerSource({
      farmOrigin: FARM_ORIGIN,
      clock: () => now,
      fetch: async (url, init) => {
        requests.push({ url, init })
        return new Response(JSON.stringify(metadata), {
          headers: { 'content-type': 'application/json' },
        })
      },
    })
    expect((await source.forKid(KID))?.kid).toBe(KID)
    expect(await source.forKid('other')).toBeNull()
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe(
      FARM_ORIGIN + '/api/configuration-authority/issuer',
    )
    expect(requests[0]?.init.redirect).toBe('error')
    // Public endpoint contract: GET only, no Bearer, no connector headers.
    expect(requests[0]?.init.method).toBe('GET')
    expect(requests[0]?.init.headers).toEqual({ accept: 'application/json' })
    now += 31_000
    expect(await source.forKid('other')).toBeNull()
    expect(requests).toHaveLength(2)
    expect(() =>
      createConfigurationIssuerSource({
        farmOrigin: 'http://farm.example.com',
      }),
    ).toThrow()
  })

  it.each(['remote close', 'wrong transport ICE'])(
    'signalling rejects %s after establishing a live context',
    async (invalidation) => {
      const w = await world()
      const runtime = w.boot()
      await runtime.start()
      const sent: Record<string, unknown>[] = []
      let handlers: { message(raw: unknown): void; close(): void } | undefined
      let socketClosed = false
      const socket: ConfigurationSocket = {
        send: (wire) => sent.push(JSON.parse(wire)),
        close: () => {
          socketClosed = true
          handlers?.close()
        },
        bind: (h) => {
          handlers = h
        },
      }
      const answers: string[] = []
      const diagnostics: Record<string, unknown>[] = []
      let bindingSeen: unknown
      const peer: ConfigurationPeerFactory = (input) => {
        void input.binding.then((b) => (bindingSeen = b)).catch(() => {})
        const session = input.session(() => {})
        return {
          session,
          closed: session.closed,
          offer: async () => sdp(0xaa),
          answer: (value) => answers.push(value),
          close: (reason) => session.close(reason),
        }
      }
      const token = 'aaaa.bbbb.cccc'
      const client = createConfigurationSignallingClient({
        identity: w.identity,
        farmOrigin: FARM_ORIGIN,
        credentialAudience: AUDIENCE,
        farmId: w.ids.farm,
        agentId: w.ids.agent,
        credential: () => ({ token, jti: w.ids.jti }),
        runtime: () => runtime,
        socket: async () => socket,
        peer,
        clock: () => w.env.now,
        retryMinMs: 60_000,
        onDiagnostic: (event) => diagnostics.push(event),
      })
      const controller = new AbortController()
      const running = client.run(controller.signal)
      const until = async (check: () => boolean) => {
        for (let i = 0; i < 200 && !check(); i++)
          await new Promise((resolve) => setTimeout(resolve, 5))
      }
      await until(() => sent.length > 0)
      expect(sent[0]).toMatchObject({
        t: 'config.connector-begin',
        jti: w.ids.jti,
      })
      const { createHash, createPublicKey } = await import('node:crypto')
      const jwk = createPublicKey({
        key: Buffer.from(w.identity.publicKeySpki, 'base64url'),
        format: 'der',
        type: 'spki',
      }).export({ format: 'jwk' })
      const challenge = {
        v: 1,
        agent_id: w.ids.agent,
        farm_id: w.ids.farm,
        jti: w.ids.jti,
        connection_id: randomUUID(),
        public_key_spki: w.identity.publicKeySpki,
        fingerprint: w.identity.fingerprint,
        thumbprint: createHash('sha256')
          .update(canonicalize({ crv: 'Ed25519', kty: 'OKP', x: jwk.x }))
          .digest('base64url'),
        token_hash: createHash('sha256').update(token).digest('base64url'),
        origin: FARM_ORIGIN,
        audience: AUDIENCE,
        purpose: 'signalling',
        generation: 1,
        nonce: nonce(),
        issued_at: w.env.now,
        expires_at: w.env.now + 30_000,
      }
      const serve = (frame: unknown) =>
        handlers?.message(encodeConfigurationSignallingServerFrame(frame))
      serve({ v: 1, t: 'config.connector-challenge', challenge })
      await until(() => sent.length > 1)
      expect(sent[1]).toMatchObject({ t: 'config.connector-proof' })
      expect(client.online()).toBe(false)
      serve({
        v: 1,
        t: 'config.connector-ready',
        inbox_id: challenge.connection_id,
        issued_at: w.env.now,
        expires_at: w.env.now + 60_000,
      })
      await until(() => sent.length > 2)
      expect(sent[2]).toEqual({
        v: 1,
        t: 'config.advertise',
        protocol: 'config-v1',
        enabled: true,
        revision: 0,
      })
      expect(client.online()).toBe(true)
      const browser = await browserKey()
      const transport = randomUUID()
      serve({
        v: 1,
        t: 'config.context-request',
        transport_id: transport,
        farm_id: w.ids.farm,
        agent_id: w.ids.agent,
        key_id: w.ids.key,
        account_id: 'account_owner',
        browser_public_key: browser.publicKey,
        browser_thumbprint: browser.thumbprint,
        connector_nonce: nonce(),
        issued_at: w.env.now,
        expires_at: w.env.now + 30_000,
      })
      await until(() => sent.length > 3)
      expect(sent[3]).toMatchObject({
        t: 'rtc.offer',
        transport_id: transport,
        seq: 0,
      })
      serve({
        v: 1,
        t: 'rtc.answer',
        transport_id: transport,
        seq: 0,
        p: { sdp: sdp(0xbb) },
      })
      await until(() => answers.length > 0)
      expect(answers).toEqual([sdp(0xbb)])
      // Trickle is not consumed: complete SDP in both peers carries every
      // candidate, and a late candidate cannot change the pinned descriptions.
      // A bounded, valid candidate stream is observed once and never relayed.
      const candidate = {
        candidate: 'candidate:1 1 udp 2122252543 192.168.1.5 50000 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0,
      }
      for (let seq = 1; seq <= 3; seq++)
        serve({
          v: 1,
          t: 'rtc.ice',
          transport_id: transport,
          seq,
          p: candidate,
        })
      await until(
        () => diagnostics.filter((e) => e.state === 'ice-ignored').length > 0,
      )
      expect(diagnostics.filter((e) => e.state === 'ice-ignored')).toHaveLength(
        1,
      )
      expect(answers).toEqual([sdp(0xbb)])
      expect(runtime.diagnostics().sessions).toBe(1)
      expect(client.online()).toBe(true)
      expect(runtime.diagnostics().sessions).toBe(1)
      expect(handlers).toBeDefined()
      if (invalidation === 'remote close') {
        handlers!.close()
      } else {
        serve({
          v: 1,
          t: 'config.context-closed',
          transport_id: randomUUID(),
        })
        serve({
          v: 1,
          t: 'rtc.ice',
          transport_id: randomUUID(),
          seq: 4,
          p: candidate,
        })
      }
      await until(() => !client.online())
      expect(client.online()).toBe(false)
      expect(socketClosed).toBe(true)
      expect(bindingSeen).toBeUndefined()
      expect(runtime.diagnostics()).toMatchObject({
        sessions: 0,
        openTransports: 0,
      })
      controller.abort()
      await running
    },
  )
})
