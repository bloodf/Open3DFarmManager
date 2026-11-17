import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createOfflineAuthority } from '../../packages/connector/src/auth/offline-authority.ts'
import { createPauseCapabilityVerifier } from '../../packages/connector/src/auth/pause-capability.ts'
import { createPrinterBindingRegistry } from '../../packages/connector/src/control/printer-binding.ts'
import * as controls from '../../packages/farm-protocol/src/control-session-binding.ts'
import * as caps from '../../packages/farm-protocol/src/pause-capability.ts'

async function commandFixture() {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const { kty, crv, x, y } = await crypto.subtle.exportKey(
    'jwk',
    pair.publicKey,
  )
  const { validateBrowserDevicePublicKey } =
    await import('../../packages/farm-protocol/src/browser-device-proof.ts')
  const { publicKey } = await validateBrowserDevicePublicKey({ kty, crv, x, y })
  const command = {
    v: 2 as const,
    purpose: 'printer-pause' as const,
    cmd_id: randomUUID(),
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    account_id: 'legacy_account',
    key_id: randomUUID(),
    transport_id: randomUUID(),
    capability_id: randomUUID(),
    assignment_id: randomUUID(),
    action: 'pause' as const,
    args: {},
    issued_at: 1000,
    expires_at: 6000,
    nonce: randomBytes(16).toString('base64url'),
  }
  return { pair, publicKey, command }
}

async function authorityFixture() {
  const { pair, publicKey, command } = await commandFixture()
  const { validateBrowserDevicePublicKey } =
    await import('../../packages/farm-protocol/src/browser-device-proof.ts')
  const { thumbprint } = await validateBrowserDevicePublicKey(publicKey)
  const issuer = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const connector = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const spki = Buffer.from(
    await crypto.subtle.exportKey('spki', connector.publicKey),
  )
  const { createHash } = await import('node:crypto')
  const digest = () => randomBytes(32).toString('base64url')
  const binding = {
    v: 1 as const,
    purpose: 'pause-rtc' as const,
    transport_id: command.transport_id,
    farm_id: command.farm_id,
    agent_id: command.agent_id,
    account_id: command.account_id,
    key_id: command.key_id,
    assignment_id: command.assignment_id,
    browser_public_key: publicKey,
    browser_thumbprint: thumbprint,
    connector_public_key_spki: spki.toString('base64url'),
    connector_fingerprint:
      'SHA256:' + createHash('sha256').update(spki).digest('base64url'),
    credential_jti: randomUUID(),
    origin: 'https://farm.example',
    audience: 'open3dfarmmanager:pause',
    browser_nonce: digest(),
    connector_nonce: digest(),
    issued_at: 1000,
    expires_at: 30000,
    offer_sha256: digest(),
    answer_sha256: digest(),
    browser_dtls: Array(32).fill('AA').join(':'),
    connector_dtls: Array(32).fill('BB').join(':'),
  }
  const { controlBindingHash } =
    await import('../../packages/farm-protocol/src/control-session-binding.ts')
  const bindingHash = await controlBindingHash(binding),
    admissionNonce = digest()
  const capability = {
    v: 1 as const,
    purpose: 'pause-authority' as const,
    capability_id: command.capability_id,
    kid: 'issuer-1',
    issuer: 'farm:issuer',
    audience: binding.audience,
    origin: binding.origin,
    issued_at: 1000,
    expires_at: 30000,
    account_id: command.account_id,
    role: 'operator' as const,
    farm_id: binding.farm_id,
    agent_id: binding.agent_id,
    key_id: binding.key_id,
    assignment_id: binding.assignment_id,
    transport_id: binding.transport_id,
    browser_public_key: publicKey,
    browser_thumbprint: thumbprint,
    connector_fingerprint: binding.connector_fingerprint,
    credential_jti: binding.credential_jti,
    printer_key: 'é"\\'.repeat(32),
    control_binding_sha256: bindingHash,
    admission_nonce: admissionNonce,
    actions: ['pause'] as ['pause'],
  }
  const challenge = {
    v: 1 as const,
    purpose: 'pause-admission' as const,
    challenge_id: randomUUID(),
    farm_id: binding.farm_id,
    agent_id: binding.agent_id,
    key_id: binding.key_id,
    assignment_id: binding.assignment_id,
    transport_id: binding.transport_id,
    account_id: binding.account_id,
    browser_thumbprint: thumbprint,
    origin: binding.origin,
    audience: binding.audience,
    control_binding_sha256: bindingHash,
    admission_nonce: admissionNonce,
    issued_at: 1000,
    expires_at: 9000,
  }
  return {
    pair,
    publicKey,
    command,
    issuer,
    connector,
    binding,
    capability,
    challenge,
  }
}

async function fixture() {
  const f = await authorityFixture()
  const offline = createOfflineAuthority()
  let wall = 1000,
    mono = 1000,
    seq = 0
  const clock = { wallNow: () => wall, monotonicNow: () => mono }
  const verifier = createPauseCapabilityVerifier({
    issuers: [
      {
        issuer: f.capability.issuer,
        kid: f.capability.kid,
        publicKey: f.issuer.publicKey,
      },
    ],
    freshness: offline.freshness,
    clock,
  })
  const registry = createPrinterBindingRegistry({
    allowedOrigins: ['http://127.0.0.1:7125'],
  })
  const printerBinding = registry.provision({
    assignment_id: f.binding.assignment_id,
    farm_id: f.binding.farm_id,
    agent_id: f.binding.agent_id,
    printer_key: f.capability.printer_key,
    moonraker_origin: 'http://127.0.0.1:7125',
  })
  const peer = verifier.createPeer(1)
  function confirm() {
    return offline.confirm({ wall, mono }, ++seq)
  }
  async function admit() {
    const binding = { ...f.binding, issued_at: wall, expires_at: wall + 29_000 }
    const hash = await controls.controlBindingHash(binding)
    const admission = verifier.beginAdmission({
      binding,
      printerBinding,
      peer: peer.peer,
    })
    const nonce = admission.challenge.admissionNonce
    const capability = await caps.signPauseCapability(
      {
        ...f.capability,
        issued_at: wall,
        expires_at: wall + 29_000,
        control_binding_sha256: hash,
        admission_nonce: nonce,
      },
      f.issuer.privateKey,
    )
    const proof = await caps.signPauseAdmissionProof(
      {
        ...f.challenge,
        issued_at: wall,
        expires_at: wall + 8_000,
        control_binding_sha256: hash,
        admission_nonce: nonce,
      },
      f.pair.privateKey,
    )
    const browser = await controls.signControlSessionProof(
      binding,
      'browser',
      f.pair.privateKey,
    )
    const connector = await controls.signControlSessionProof(
      binding,
      'connector',
      f.connector.privateKey,
    )
    return verifier.admit(admission.token, {
      capabilityWire: caps.encodePauseCapability(capability),
      admissionProofWire: caps.encodePauseAdmissionProof(proof),
      browserProofWire: controls.encodeControlProof({
        v: 1,
        role: 'browser',
        binding,
        signature: browser,
      }),
      connectorProofWire: controls.encodeControlProof({
        v: 1,
        role: 'connector',
        binding,
        signature: connector,
      }),
    })
  }
  return {
    verifier,
    offline,
    confirm,
    admit,
    sample: () => verifier.inspectAt(undefined, wall, mono),
    begin: () =>
      verifier.beginAdmission({
        binding: f.binding,
        printerBinding,
        peer: peer.peer,
      }),
    advance: (wallDelta: number, monoDelta: number) => {
      wall += wallDelta
      mono += monoDelta
    },
  }
}

test('20 ppm drift over 48 hours accepts newly signed capabilities with confirmations', async () => {
  const f = await fixture()
  assert.equal(f.confirm(), true)
  assert.equal((await f.admit()).ok, true)
  for (let i = 1; i <= 48 * 60 * 12; i++) {
    f.advance(5000, 4999.9)
    assert.equal(f.confirm(), true)
    f.sample()
    if (i % 720 === 0) assert.equal((await f.admit()).ok, true)
  }
})

test('forward step denies until a new confirmation', async () => {
  const f = await fixture()
  assert.equal(f.confirm(), true)
  const first = await f.admit()
  assert.ok(first.ok)
  f.advance(2001, 1)
  assert.equal(f.verifier.inspect(first.handle).ok, false)
  assert.throws(() => f.begin(), /Untrustworthy local clock/)
  assert.equal(f.confirm(), true)
  assert.equal(f.verifier.inspect(first.handle).ok, true)
  assert.equal((await f.admit()).ok, true)
})

test('backwards wall or monotonic samples remain refused after confirmation', async () => {
  for (const [wallDelta, monoDelta] of [
    [-1, 1],
    [1, -1],
  ] as const) {
    const f = await fixture()
    assert.equal(f.confirm(), true)
    assert.equal((await f.admit()).ok, true)
    f.advance(wallDelta, monoDelta)
    f.sample()
    assert.equal(f.confirm(), false)
    f.advance(2, 2)
    assert.equal(f.confirm(), true)
    assert.throws(() => f.begin(), /Untrustworthy local clock/)
  }
})
