import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import {
  RtcSessionBinding,
  signRtcSessionProof,
  decodeRtcProof,
  encodeRtcProof,
} from '../../packages/farm-protocol/src/rtc-session-binding.ts'
import {
  ReadonlyRtcSession,
  READONLY_FIXTURE_STATUS,
} from '../../packages/connector/src/webrtc/readonly-session.ts'

async function fixture() {
  const identity = new ConnectorIdentity(
    generateKeyPairSync('ed25519').privateKey,
  )
  const browser = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const jwk = await crypto.subtle.exportKey('jwk', browser.publicKey)
  const publicKey = await validateBrowserDevicePublicKey({
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
  })
  const nonce = () => randomBytes(32).toString('base64url')
  const issued = Date.now() - 100
  const binding = RtcSessionBinding.parse({
    v: 1,
    purpose: 'read-only-rtc',
    transport_id: randomUUID(),
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    account_id: 'synthetic_account',
    key_id: randomUUID(),
    browser_public_key: publicKey.publicKey,
    browser_thumbprint: publicKey.thumbprint,
    connector_public_key_spki: identity.publicKeySpki,
    connector_fingerprint: identity.fingerprint,
    credential_jti: randomUUID(),
    origin: 'https://farm.example',
    audience: 'open3dfarmmanager:connector',
    browser_nonce: nonce(),
    connector_nonce: nonce(),
    issued_at: issued,
    expires_at: issued + 30000,
    commands_enabled: false,
    offer_sha256: nonce(),
    answer_sha256: nonce(),
    browser_dtls: Array(32).fill('AA').join(':'),
    connector_dtls: Array(32).fill('BB').join(':'),
  })
  const browserProof = async (value = binding) => ({
    v: 1 as const,
    role: 'browser' as const,
    binding: value,
    signature: await signRtcSessionProof(value, 'browser', browser.privateKey),
  })
  const connectorProof = () =>
    identity.signRtcSessionProof({ binding, expectedAgentId: binding.agent_id })
  const sent: string[] = []
  const make = (
    overrides: Partial<
      ConstructorParameters<typeof ReadonlyRtcSession>[0]
    > = {},
  ) =>
    new ReadonlyRtcSession({
      binding,
      role: 'connector',
      authDeadline: performance.now() + 3000,
      lifetimeDeadline: performance.now() + 5000,
      signProof: connectorProof,
      sendProof: (wire) => sent.push(wire),
      sendApplication: (wire) => sent.push(wire),
      onVerified: () => {},
      onReadonly: () => {},
      ...overrides,
    })
  const decode = (proof: unknown) => decodeRtcProof(encodeRtcProof(proof))
  return { binding, browserProof, connectorProof, decode, make, sent }
}

test('real role proofs authorize only the fixture status and commands stay disabled', async () => {
  const f = await fixture()
  const session = f.make()
  try {
    await session.start()
    await session.inspectProof(f.decode(await f.browserProof()))
    assert.equal(session.snapshot().state, 'verified')
    assert.equal(session.sendStatus(), true)
    session.receiveApplication(READONLY_FIXTURE_STATUS)
    assert.deepEqual(session.snapshot().accepted, ['fixture-idle'])
    assert.equal(session.snapshot().commands_enabled, false)
    session.receiveApplication('{"kind":"command"}')
    assert.equal(session.snapshot().state, 'readonly')
  } finally {
    session.close()
  }
})

test('application before authentication and foreign role, context or replay proofs fail closed', async () => {
  const f = await fixture()
  const before = f.make()
  before.receiveApplication(READONLY_FIXTURE_STATUS)
  assert.equal(before.snapshot().state, 'readonly')
  before.close()
  for (const proof of [
    f.connectorProof(),
    await f.browserProof({ ...f.binding, transport_id: randomUUID() }),
  ]) {
    const session = f.make()
    try {
      await session.inspectProof(f.decode(proof))
      assert.equal(session.snapshot().state, 'readonly')
      assert.deepEqual(session.snapshot().accepted, [])
    } finally {
      session.close()
    }
  }
  const replay = f.make()
  try {
    const proof = f.decode(await f.browserProof())
    await replay.start()
    await replay.inspectProof(proof)
    assert.equal(replay.snapshot().state, 'verified')
    await replay.inspectProof(proof)
    assert.equal(replay.snapshot().state, 'readonly')
  } finally {
    replay.close()
  }
})

test('close or expired deadline during signing cannot revive session or emit proof', async () => {
  const f = await fixture()
  for (const mode of ['close', 'deadline'] as const) {
    let release: ((value: unknown) => void) | undefined
    const session = f.make({
      authDeadline: performance.now() + (mode === 'deadline' ? 30 : 3000),
      signProof: () =>
        new Promise((resolve) => {
          release = resolve
        }),
    })
    try {
      const start = session.start()
      if (mode === 'close') session.close()
      else await new Promise((resolve) => setTimeout(resolve, 60))
      release?.(f.connectorProof())
      await start
      assert.equal(session.snapshot().state, 'readonly')
      assert.equal(session.snapshot().localProof, false)
      assert.equal(session.sendStatus(), false)
      assert.deepEqual(f.sent, [])
    } finally {
      session.close()
    }
  }
})

test('remote proof cannot admit application while local signing is pending', async () => {
  const f = await fixture()
  let release: ((proof: unknown) => void) | undefined
  let verified = 0
  const session = f.make({
    signProof: () =>
      new Promise((resolve) => {
        release = resolve
      }),
    onVerified: () => {
      verified++
    },
  })
  try {
    const signing = session.start()
    await session.inspectProof(f.decode(await f.browserProof()))
    assert.equal(session.snapshot().state, 'pending')
    assert.equal(verified, 0)
    session.receiveApplication(READONLY_FIXTURE_STATUS)
    assert.equal(session.snapshot().state, 'readonly')
    assert.deepEqual(session.snapshot().accepted, [])
    release?.(f.connectorProof())
    await signing
    assert.equal(session.snapshot().state, 'readonly')
    assert.equal(session.snapshot().localProof, false)
    assert.equal(verified, 0)
    assert.deepEqual(f.sent, [])
  } finally {
    session.close()
  }
})
