import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
type Native =
  typeof import('../../packages/connector/node_modules/node-datachannel')
const native: Native = createRequire(
  new URL('../../packages/connector/package.json', import.meta.url),
)('node-datachannel')
const { PeerConnection } = native
type DataChannel = ReturnType<
  InstanceType<Native['PeerConnection']>['createDataChannel']
>
import { base64url } from '../../packages/farm-protocol/src/encoding.ts'
import { canonicalize } from '../../packages/farm-protocol/src/canonical.ts'
import {
  controlDtlsFingerprint,
  controlSdpHash,
} from '../../packages/farm-protocol/src/control-session-binding.ts'
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
import { configurationReceiptHash } from '../../packages/farm-protocol/src/configuration-receipt.ts'
import { configurationTargetHash } from '../../packages/farm-protocol/src/configuration-target.ts'
import { readAgentRuntimeConfig } from '../../packages/connector/src/config/runtime.ts'
import { parseProvisioningConfig } from '../../packages/connector/src/config/provisioning.ts'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import type { KobraLinkFetch } from '../../packages/connector/src/kobralink/client.ts'
import { createRuntimeActivator } from '../../packages/connector/src/runtime/configuration-activation.ts'
import { fixedConfigurationIssuer } from '../../packages/connector/src/runtime/configuration-issuer.ts'
import { createConfigurationRuntime } from '../../packages/connector/src/runtime/configuration.ts'
import {
  decodeConnectorChannelMessage,
  encodeBrowserChannelMessage,
} from '../../packages/connector/src/webrtc/configuration-channel.ts'
import { ConfigurationConnectorPeer } from '../../packages/connector/src/webrtc/configuration-peer.ts'

/*
 * Real loopback node-datachannel transport between the Connector peer and a
 * native peer playing the browser. MOCK-ONLY boundaries: synthetic issuer,
 * synthetic in-memory KobraLink service, synthetic runtime start. No external
 * network, no printer, no shared engine.
 */
const FARM_ORIGIN = 'https://farm.example.com'
const AUDIENCE = 'open3dfarm/connector'
const KID = 'config-issuer-1'
const cli = fileURLToPath(
  new URL('../../packages/connector/src/cli.ts', import.meta.url),
)

function bridge() {
  const state = { needsSetup: true, creates: 0, tokens: new Set<string>() }
  const users: string[] = []
  const printers: { id: string; deviceId: string; ip: string }[] = []
  const json = (value: unknown, status = 200, extra = {}) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json', ...extra },
    })
  const login = () => {
    const token = randomUUID()
    state.tokens.add(token)
    return json({}, 200, {
      'set-cookie': `better-auth.session_token=${token}; HttpOnly; Path=/`,
    })
  }
  const wire = (p: (typeof printers)[number]) => ({
    ...p,
    name: 'Kobra X',
    username: 'x',
    model: 'Kobra X',
    live: null,
  })
  const fetch: KobraLinkFetch = async (url, init) => {
    const { pathname } = new URL(url)
    const method = init.method ?? 'GET'
    if (pathname === '/api/v1/setup/status')
      return json({ needsSetup: state.needsSetup })
    if (pathname === '/api/auth/sign-up/email') {
      state.needsSetup = false
      const body = JSON.parse(String(init.body))
      users.push(`${body.email}\n${body.password}`)
      return login()
    }
    if (pathname === '/api/auth/sign-in/email') {
      const body = JSON.parse(String(init.body))
      return users.includes(`${body.email}\n${body.password}`)
        ? login()
        : json({}, 401)
    }
    const cookie = String(
      (init.headers as Record<string, string>).Cookie ?? '',
    ).split('=')[1]
    if (!cookie || !state.tokens.has(cookie)) return json({}, 401)
    if (pathname === '/api/v1/printers' && method === 'GET')
      return json(printers.map(wire))
    if (pathname === '/api/v1/printers' && method === 'POST') {
      const body = JSON.parse(String(init.body))
      state.creates++
      const created = { id: 'p1', deviceId: 'kx-0001', ip: body.ip }
      printers.push(created)
      return json(wire(created))
    }
    return json({}, 404)
  }
  return { state, fetch }
}

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
const nonce = () => base64url(crypto.getRandomValues(new Uint8Array(32)))

async function setup() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cfg-connector-rtc-')))
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
  const service = bridge()
  const config = parseProvisioningConfig({
    version: 1,
    mode: 'configuration-provisioning',
    farm_id: ids.farm,
    agent_id: ids.agent,
    farmOrigin: FARM_ORIGIN,
    credentialAudience: AUDIENCE,
    stateDirectory: join(dir, 'state'),
    runtimeConfigPath: join(dir, 'runtime.json'),
    printerNetworks: ['192.168.1.0/24'],
    managedBridge: {
      origin: 'http://127.0.0.1:7100',
      ownership: 'connector-owned-fresh',
    },
    runtimeTemplate: {
      telemetry: {
        endpoint: FARM_ORIGIN + '/api/connector/telemetry',
        audience: AUDIENCE,
      },
    },
  })
  let starts = 0
  const runtime = createConfigurationRuntime({
    identity,
    config,
    issuers: fixedConfigurationIssuer({
      kid: KID,
      origin: FARM_ORIGIN,
      audience: AUDIENCE,
      key: issuerKeys.publicKey,
    }),
    activator: createRuntimeActivator({
      runtimeConfigPath: config.runtimeConfigPath,
      scope: { agent_id: ids.agent, farm_id: ids.farm },
      snapshotPath: join(dir, 'state', 'collection-snapshot.json'),
      start: (signal) =>
        new Promise<void>((resolve) => {
          starts++
          signal.addEventListener('abort', () => resolve())
        }),
    }),
    serverOnline: () => true,
    credentialJti: () => ids.jti,
    fetch: service.fetch,
  })
  return {
    dir,
    ids,
    identity,
    issuerKeys,
    service,
    config,
    runtime,
    starts: () => starts,
  }
}

type Setup = Awaited<ReturnType<typeof setup>>

/** Opens one real loopback config transport; the native peer plays the browser. */
async function connect(s: Setup) {
  const browser = await browserKey()
  const transportId = randomUUID()
  const connectorNonce = nonce()
  let resolveBinding: (value: unknown) => void = () => {}
  const bindingPromise = new Promise<unknown>((resolve) => {
    resolveBinding = resolve
  })
  const peer = new ConfigurationConnectorPeer({
    bindAddress: '127.0.0.1',
    binding: bindingPromise,
    session: (send) =>
      s.runtime.openSession({
        expected: {
          transportId,
          farmId: s.ids.farm,
          agentId: s.ids.agent,
          accountId: 'account_owner',
          keyId: s.ids.key,
          browserThumbprint: browser.thumbprint,
          credentialJti: s.ids.jti,
          connectorNonce,
        },
        send,
      }),
  })
  const offer = await peer.offer()
  const native = new PeerConnection('browser', {
    iceServers: [],
    bindAddress: '127.0.0.1',
    enableIceTcp: false,
  })
  let gathered: () => void = () => {}
  const gathering = new Promise<void>((resolve) => {
    gathered = resolve
  })
  native.onGatheringStateChange((state) => {
    if (state === 'complete') gathered()
  })
  const inbox: ReturnType<typeof decodeConnectorChannelMessage>[] = []
  let wake: () => void = () => {}
  let channel: DataChannel | undefined
  const opened = new Promise<void>((resolve) => {
    native.onDataChannel((incoming) => {
      channel = incoming
      incoming.onMessage((raw) => {
        inbox.push(decodeConnectorChannelMessage(String(raw)))
        wake()
      })
      resolve()
    })
  })
  native.setRemoteDescription(offer, 'offer')
  await gathering
  const answer = native.localDescription()!.sdp
  peer.answer(answer)
  const binding = {
    v: 1,
    purpose: 'configuration-rtc',
    protocol: 'config-v1',
    transport_id: transportId,
    farm_id: s.ids.farm,
    agent_id: s.ids.agent,
    account_id: 'account_owner',
    key_id: s.ids.key,
    browser_public_key: browser.publicKey,
    browser_thumbprint: browser.thumbprint,
    connector_public_key_spki: s.identity.publicKeySpki,
    connector_fingerprint: s.identity.fingerprint,
    credential_jti: s.ids.jti,
    origin: FARM_ORIGIN,
    audience: AUDIENCE,
    browser_nonce: nonce(),
    connector_nonce: connectorNonce,
    issued_at: Date.now(),
    expires_at: Date.now() + 30_000,
    offer_sha256: await controlSdpHash(offer),
    answer_sha256: await controlSdpHash(answer),
    browser_dtls: controlDtlsFingerprint(answer),
    connector_dtls: controlDtlsFingerprint(offer),
  }
  resolveBinding(binding)
  const next = async (ms = 5000) => {
    const end = Date.now() + ms
    while (
      inbox.length === 0 &&
      Date.now() < end &&
      !peer.diagnostics().terminal
    )
      await new Promise<void>((resolve) => {
        wake = resolve
        setTimeout(resolve, 20)
      })
    return inbox.shift()
  }
  const close = () => {
    peer.close('test-done')
    try {
      channel?.close()
    } catch {}
    native.close()
  }
  return {
    peer,
    native,
    opened,
    next,
    binding,
    browser,
    close,
    channel: () => channel,
  }
}

test('real loopback config RTC: proofs, prepare, commit and runtime activation', async () => {
  const s = await setup()
  const c = await connect(s)
  try {
    await c.opened
    const connectorProof = await c.next()
    assert.equal(connectorProof?.t, 'proof')
    const send = (message: unknown) =>
      c.channel()!.sendMessage(encodeBrowserChannelMessage(message))
    send({
      v: 1,
      t: 'proof',
      proof: encodeConfigurationSessionProof({
        v: 1,
        role: 'browser',
        binding: c.binding,
        signature: await signConfigurationSessionProof(
          c.binding,
          'browser',
          c.browser.pair.privateKey,
        ),
      }),
    })
    for (let i = 0; i < 100 && c.peer.session.state !== 'authenticated'; i++)
      await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(c.peer.session.state, 'authenticated')

    const request = async (
      frame: Record<string, unknown>,
    ): Promise<ConfigurationResponseFrame> => {
      const now = Date.now()
      const common = {
        capability_id: randomUUID(),
        farm_id: s.ids.farm,
        agent_id: s.ids.agent,
        key_id: s.ids.key,
        transport_id: c.binding.transport_id,
        account_id: 'account_owner',
        browser_thumbprint: c.browser.thumbprint,
        origin: FARM_ORIGIN,
        audience: AUDIENCE,
        configuration_binding_sha256: await configurationBindingHash(c.binding),
        admission_nonce: nonce(),
        action: frame.type,
        operation_id: frame.operation_id,
        expected_revision: frame.expected_revision,
        target_sha256: await configurationFrameTargetHash(frame),
      }
      const admission = await signConfigurationAdmissionProof(
        {
          v: 1,
          purpose: 'configuration-admission',
          protocol: 'config-v1',
          challenge_id: randomUUID(),
          ...common,
          issued_at: now,
          expires_at: now + 8000,
        },
        c.browser.pair.privateKey,
      )
      const capability = await signConfigurationCapability(
        {
          v: 1,
          purpose: 'configuration-authority',
          protocol: 'config-v1',
          kid: KID,
          issuer: 'open3dfarm/config-issuer',
          issued_at: now,
          expires_at: c.binding.expires_at,
          role: 'owner',
          browser_public_key: c.browser.publicKey,
          connector_fingerprint: s.identity.fingerprint,
          credential_jti: s.ids.jti,
          ...common,
        },
        s.issuerKeys.privateKey,
      )
      send({
        v: 1,
        t: 'request',
        frame: encodeConfigurationRequest(frame),
        capability: encodeConfigurationCapability(capability),
        admission: encodeConfigurationAdmissionProof(admission),
      })
      const message = await c.next()
      assert.equal(message?.t, 'response')
      if (message?.t !== 'response') throw new Error('no response')
      return decodeConfigurationResponse(message.frame)
    }
    const op = randomUUID()
    const target = {
      v: 1,
      protocol: 'config-v1',
      backend: 'kobralink-anycubic',
      model: { family: 'anycubic-kobra-x', provisional: true },
      endpoint: { ipv4: '192.168.1.50', port: 18910 },
      bridge: { kind: 'connector-managed' },
    }
    const base = {
      v: 1,
      protocol: 'config-v1',
      operation_id: op,
      expected_revision: 0,
    }
    const prepared = await request({
      ...base,
      type: 'prepare',
      request_id: randomUUID(),
      target,
    })
    assert.equal(prepared.type === 'result' && prepared.state, 'prepared')
    if (prepared.type !== 'result') throw new Error('prepare failed')
    const committed = await request({
      ...base,
      type: 'commit',
      request_id: randomUUID(),
      target_sha256: await configurationTargetHash(target),
      prepared_receipt_sha256: await configurationReceiptHash(prepared.receipt),
    })
    assert.equal(
      committed.type === 'result' && committed.state,
      'local-committed',
    )
    assert.equal(s.service.state.creates, 1)
    // Unconfirmed: the local commit alone never starts collection.
    assert.equal(s.starts(), 0)
    const runtimeConfig = readAgentRuntimeConfig(s.config.runtimeConfigPath, {
      agent_id: s.ids.agent,
      farm_id: s.ids.farm,
    })
    assert.equal(runtimeConfig.assignments.length, 1)
    assert.equal(c.peer.session.requests, 2)
  } finally {
    c.close()
    await c.peer.closed
    await s.runtime.shutdown()
    rmSync(s.dir, { recursive: true, force: true })
  }
})

test('a browser-created channel closes the config transport before authentication', async () => {
  const s = await setup()
  const c = await connect(s)
  try {
    // Opened only after DTLS roles are settled, so stream ids are distinct.
    await c.opened
    c.native.createDataChannel('other-purpose')
    for (let i = 0; i < 250 && !c.peer.diagnostics().terminal; i++)
      await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(c.peer.diagnostics().terminal, 'unexpected-channel')
    assert.notEqual(c.peer.session.state, 'authenticated')
    assert.equal(s.runtime.diagnostics().openTransports, 0)
    assert.equal(s.service.state.creates, 0)
  } finally {
    c.close()
    await c.peer.closed
    await s.runtime.shutdown()
    rmSync(s.dir, { recursive: true, force: true })
  }
})

test('configure CLI validates locally without network and prints no secrets', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cfg-connector-cli-')))
  try {
    const run = (args: string[]) =>
      spawnSync(process.execPath, [cli, ...args], {
        encoding: 'utf8',
        timeout: 30_000,
      })
    const data = join(dir, 'data')
    const init = run(['init-identity', '--data-dir', data])
    assert.equal(init.status, 0, init.stderr)
    const identity = JSON.parse(init.stdout)
    const farm = randomUUID()
    const agent = randomUUID()
    const payload = Buffer.from(JSON.stringify({ jti: randomUUID() })).toString(
      'base64url',
    )
    const token = `aGVhZGVy.${payload}.c2ln`
    const credential = join(dir, 'credential.json')
    writeFileSync(
      credential,
      JSON.stringify({
        version: 1,
        expected_fingerprint: identity.fingerprint,
        approval: {
          status: 'approved',
          agent_id: agent,
          farm_id: farm,
          device_token: token,
          expires_at: Date.now() + 3_600_000,
        },
      }),
      { mode: 0o600 },
    )
    const provisioning = join(dir, 'provisioning.json')
    writeFileSync(
      provisioning,
      JSON.stringify({
        version: 1,
        mode: 'configuration-provisioning',
        farm_id: farm,
        agent_id: agent,
        farmOrigin: FARM_ORIGIN,
        credentialAudience: AUDIENCE,
        stateDirectory: join(dir, 'state'),
        runtimeConfigPath: join(dir, 'runtime.json'),
        printerNetworks: ['192.168.1.0/24'],
        managedBridge: {
          origin: 'http://127.0.0.1:7100',
          ownership: 'connector-owned-fresh',
        },
        runtimeTemplate: {
          telemetry: {
            endpoint: FARM_ORIGIN + '/api/connector/telemetry',
            audience: AUDIENCE,
          },
        },
      }),
      { mode: 0o600 },
    )
    const args = [
      'configure',
      '--provisioning',
      provisioning,
      '--data-dir',
      data,
      '--credential-file',
      credential,
      '--check',
    ]
    const ok = run(args)
    assert.equal(ok.status, 0, ok.stderr)
    assert.deepEqual(JSON.parse(ok.stdout), {
      fingerprint: identity.fingerprint,
      farm_id: farm,
      agent_id: agent,
      mode: 'configuration-provisioning',
      managedBridge: true,
      runtime: 'absent',
    })
    assert.ok(!ok.stdout.includes(token))
    assert.equal(existsSync(join(dir, 'runtime.json')), false)

    // A browser-reachable LAN management origin is refused locally.
    writeFileSync(
      provisioning,
      JSON.stringify({
        version: 1,
        mode: 'configuration-provisioning',
        farm_id: farm,
        agent_id: agent,
        farmOrigin: FARM_ORIGIN,
        credentialAudience: AUDIENCE,
        stateDirectory: join(dir, 'state'),
        runtimeConfigPath: join(dir, 'runtime.json'),
        printerNetworks: ['192.168.1.0/24'],
        managedBridge: {
          origin: 'http://192.168.1.20:7100',
          ownership: 'connector-owned-fresh',
        },
        runtimeTemplate: { telemetry: {} },
      }),
      { mode: 0o600 },
    )
    const refused = run(args)
    assert.equal(refused.status, 1)
    assert.ok(!refused.stderr.includes(dir))
    assert.ok(!refused.stderr.includes(token))
    assert.equal(run(['configure', '--provisioning', provisioning]).status, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
