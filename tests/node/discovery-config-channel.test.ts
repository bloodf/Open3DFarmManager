import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
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
} from '../../packages/farm-protocol/src/configuration-frames.ts'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import { fixedConfigurationIssuer } from '../../packages/connector/src/runtime/configuration-issuer.ts'
import {
  decodeConnectorChannelMessage,
  encodeBrowserChannelMessage,
} from '../../packages/connector/src/webrtc/configuration-channel.ts'
import { ConfigurationConnectorPeer } from '../../packages/connector/src/webrtc/configuration-peer.ts'

import {
  discoveryRequest,
  decodeDiscoveryResult,
  DiscoveryResult,
} from '../../packages/farm-protocol/src/configuration-discovery.ts'
import { createConfigurationAuthority } from '../../packages/connector/src/runtime/configuration-authority.ts'
import {
  ConfigurationConnectorSession,
  type ConfigurationSessionOptions,
} from '../../packages/connector/src/webrtc/configuration-session.ts'
import {
  scanConfigurationDiscovery,
  type DiscoveryScanner,
} from '../../packages/connector/src/runtime/configuration-discovery.ts'

const FARM_ORIGIN = 'https://farm.example.com'
const AUDIENCE = 'open3dfarm/connector'
const KID = 'config-issuer-1'
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

async function setup(scan: DiscoveryScanner) {
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
  const issuers = fixedConfigurationIssuer({
    kid: KID,
    origin: FARM_ORIGIN,
    audience: AUDIENCE,
    key: issuerKeys.publicKey,
  })
  let online = true
  const authority = createConfigurationAuthority({
    farm_id: ids.farm,
    agent_id: ids.agent,
    issuers,
    serverOnline: () => online,
    credentialJti: () => ids.jti,
  })
  const runtime = {
    openSession: (
      options: Pick<ConfigurationSessionOptions, 'expected' | 'send'>,
    ) =>
      new ConfigurationConnectorSession({
        ...options,
        identity,
        issuers,
        authority,
        discovery: scan,
        claimFresh: () => true,
        handler: {
          handle: async () => {
            throw Error('discovery must not execute provisioning')
          },
          confirmInventory: async () => ({ ok: false, reason: 'rejected' }),
        },
      }),
  }
  return {
    ids,
    identity,
    issuerKeys,
    authority,
    runtime,
    offline: () => {
      online = false
    },
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

async function authenticate(c: Awaited<ReturnType<typeof connect>>) {
  await c.opened
  const connectorProof = await c.next()
  assert.equal(connectorProof?.t, 'proof')
  c.channel()!.sendMessage(
    encodeBrowserChannelMessage({
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
    }),
  )
  for (let i = 0; i < 100 && c.peer.session.state !== 'authenticated'; i++)
    await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(c.peer.session.state, 'authenticated')
}

test('signed discovery over loopback: authority, concurrency, deduplication and bounds', async () => {
  let calls = 0
  let finish: (value: Awaited<ReturnType<DiscoveryScanner>>) => void = () => {}
  const s = await setup(async (options) => {
    calls++
    assert.equal(options?.timeout, 4500)
    return new Promise((resolve) => {
      finish = resolve
    })
  })
  const c = await connect(s)
  try {
    await authenticate(c)
    const send = (message: unknown) =>
      c.channel()!.sendMessage(encodeBrowserChannelMessage(message))
    const signed = async (client = c, role: 'admin' | 'owner' = 'admin') => {
      const frame = await discoveryRequest(randomUUID(), randomUUID())
      const now = Date.now()
      const common = {
        capability_id: randomUUID(),
        farm_id: s.ids.farm,
        agent_id: s.ids.agent,
        key_id: s.ids.key,
        transport_id: client.binding.transport_id,
        account_id: 'account_owner',
        browser_thumbprint: client.browser.thumbprint,
        origin: FARM_ORIGIN,
        audience: AUDIENCE,
        configuration_binding_sha256: await configurationBindingHash(
          client.binding,
        ),
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
        client.browser.pair.privateKey,
      )
      const capability = await signConfigurationCapability(
        {
          v: 1,
          purpose: 'configuration-authority',
          protocol: 'config-v1',
          kid: KID,
          issuer: 'open3dfarm/config-issuer',
          issued_at: now,
          expires_at: client.binding.expires_at,
          role,
          browser_public_key: client.browser.publicKey,
          connector_fingerprint: s.identity.fingerprint,
          credential_jti: s.ids.jti,
          ...common,
        },
        s.issuerKeys.privateKey,
      )
      return {
        v: 1,
        t: 'discovery',
        frame: encodeConfigurationRequest(frame),
        capability: encodeConfigurationCapability(capability),
        admission: encodeConfigurationAdmissionProof(admission),
      }
    }
    const unauthorized = await signed()
    const cap = JSON.parse(unauthorized.capability)
    cap.role = 'viewer'
    send({ ...unauthorized, capability: canonicalize(cap) })
    const rejection = await c.next()
    assert.equal(rejection?.t, 'response')
    if (rejection?.t !== 'response') throw Error('missing rejection')
    assert.equal(decodeConfigurationResponse(rejection.frame).type, 'error')
    assert.equal(calls, 0)
    const wrongTarget = await signed()
    const wrongFrame = JSON.parse(wrongTarget.frame)
    wrongFrame.target_sha256 = nonce()
    send({ ...wrongTarget, frame: encodeConfigurationRequest(wrongFrame) })
    const invalid = await c.next()
    assert.equal(invalid?.t, 'response')
    if (invalid?.t !== 'response') throw Error('missing target rejection')
    assert.equal(JSON.parse(invalid.frame).code, 'invalid-request')
    assert.equal(calls, 0)
    send(await signed())
    for (let i = 0; i < 100 && calls === 0; i++)
      await new Promise((r) => setTimeout(r, 10))
    assert.equal(calls, 1)
    const second = await connect(s)
    try {
      await authenticate(second)
      second
        .channel()!
        .sendMessage(encodeBrowserChannelMessage(await signed(second, 'owner')))
      const blocked = await second.next()
      assert.equal(blocked?.t, 'response')
      if (blocked?.t !== 'response') throw Error('missing shared busy response')
      assert.equal(JSON.parse(blocked.frame).reason, 'busy')
    } finally {
      second.close()
      await second.peer.closed
    }
    send(await signed())
    const busy = await c.next()
    assert.equal(busy?.t, 'response')
    if (busy?.t !== 'response') throw Error('missing busy response')
    assert.equal(decodeDiscoveryResult(busy.frame).ok, false)
    assert.equal(JSON.parse(busy.frame).reason, 'busy')
    const p = { vendor: 'moonraker' as const, host: '192.168.1.2', port: 7125 }
    finish([
      p,
      p,
      ...Array.from({ length: 80 }, (_, i) => ({
        ...p,
        host: `192.168.1.${i + 3}`,
        password: 'must-not-leak',
        name: '"'.repeat(128),
        model: '\\'.repeat(128),
      })),
    ])
    const result = await c.next()
    assert.equal(result?.t, 'response')
    if (result?.t !== 'response') throw Error('missing discovery response')
    const parsed = decodeDiscoveryResult(result.frame)
    assert.equal(parsed.ok, true)
    if (!parsed.ok) throw Error('scan failed')
    assert.equal(parsed.printers.length, 64)
    assert.equal(new Set(parsed.printers.map((p) => p.host)).size, 64)
    assert.equal(result.frame.includes('must-not-leak'), false)
    assert.equal(
      DiscoveryResult.safeParse({
        ...parsed,
        printers: [...parsed.printers, p],
      }).success,
      false,
    )
    s.offline()
    send(await signed())
    const offline = await c.next()
    assert.equal(offline?.t, 'response')
    assert.equal(calls, 1)
  } finally {
    c.close()
    await c.peer.closed
    s.authority.revokeAll()
  }
})

test('discovery deadline retains the connector lease until scanner cleanup', async () => {
  let finish: (value: []) => void = () => {}
  const s = await setup(async () => [])
  const work = scanConfigurationDiscovery(
    s.authority,
    randomUUID(),
    async () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const result = await work
  assert.equal(result.ok, false)
  if (result.ok) throw Error('expected timeout')
  assert.equal(result.reason, 'timeout')
  assert.equal(
    (await scanConfigurationDiscovery(s.authority, randomUUID())).ok,
    false,
  )
  finish([])
  await new Promise((resolve) => setImmediate(resolve))
  const recovered = await scanConfigurationDiscovery(
    s.authority,
    randomUUID(),
    async () => [],
  )
  assert.deepEqual(recovered, {
    request_id: recovered.request_id,
    ok: true,
    printers: [],
  })
})

test('discovery failure releases its lease and sanitizes errors', async () => {
  const s = await setup(async () => [])
  const id = randomUUID()
  assert.deepEqual(
    await scanConfigurationDiscovery(s.authority, id, async () => {
      throw Error('secret credential')
    }),
    { request_id: id, ok: false, reason: 'failed' },
  )
  assert.deepEqual(
    await scanConfigurationDiscovery(s.authority, id, async () => []),
    { request_id: id, ok: true, printers: [] },
  )
})
