import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import {
  RtcProofInbox,
  boundRtcApplicationFrame,
} from '../../packages/connector/src/webrtc/rtc-proof-inbox.ts'
import {
  encodeRtcProof,
  decodeRtcProof,
} from '../../packages/farm-protocol/src/rtc-session-binding.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'

async function proofWire() {
  const identity = new ConnectorIdentity(
    generateKeyPairSync('ed25519').privateKey,
  )
  const browser = await validateBrowserDevicePublicKey(
    generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({
      format: 'jwk',
    }),
  )
  const agent = randomUUID()
  const digest = () => randomBytes(32).toString('base64url')
  return encodeRtcProof(
    identity.signRtcSessionProof({
      expectedAgentId: agent,
      binding: {
        v: 1,
        purpose: 'read-only-rtc',
        transport_id: randomUUID(),
        farm_id: randomUUID(),
        agent_id: agent,
        account_id: 'test_account',
        key_id: randomUUID(),
        browser_public_key: browser.publicKey,
        browser_thumbprint: browser.thumbprint,
        connector_public_key_spki: identity.publicKeySpki,
        connector_fingerprint: identity.fingerprint,
        credential_jti: randomUUID(),
        origin: 'https://farm.example',
        audience: 'open3dfarmmanager:connector',
        browser_nonce: digest(),
        connector_nonce: digest(),
        issued_at: 1000,
        expires_at: 31000,
        commands_enabled: false,
        offer_sha256: digest(),
        answer_sha256: digest(),
        browser_dtls: Array(32).fill('AA').join(':'),
        connector_dtls: Array(32).fill('BB').join(':'),
      },
    }),
  )
}

test('real canonical proof decoding is inspection only, with active byte charge retained until settlement', async () => {
  const wire = await proofWire()
  let finish: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    finish = resolve
  })
  let calls = 0,
    closed = 0
  const inbox = new RtcProofInbox({
    paused: false,
    inspect: async (proof) => {
      assert.deepEqual(proof, decodeRtcProof(wire))
      calls++
      await held
    },
    onReadonly: () => {
      closed++
    },
  })
  const batch = inbox.receive(wire)
  for (let i = 0; i < 3; i++) assert.equal(inbox.receive(wire), batch)
  assert.equal(
    inbox.snapshot().work.retainedBytes,
    new TextEncoder().encode(wire).byteLength * 4,
  )
  inbox.receive(wire)
  assert.equal(inbox.snapshot().state.kind, 'readonly')
  assert.equal(inbox.snapshot().work.pending, 1)
  assert.equal(
    inbox.snapshot().work.retainedBytes,
    new TextEncoder().encode(wire).byteLength,
  )
  const terminal = inbox.snapshot()
  for (let i = 0; i < 100000; i++) inbox.receive(wire)
  assert.deepEqual(inbox.snapshot(), terminal)
  finish()
  await batch
  assert.equal(calls, 1)
  assert.equal(closed, 1)
  assert.equal(inbox.snapshot().work.pending, 0)
  assert.equal(inbox.snapshot().work.retainedBytes, 0)
  inbox.activate()
  inbox.close()
  assert.equal(closed, 1)
})

test('malformed, oversized and noncanonical proof frames fail closed before inspection', async () => {
  const wire = await proofWire()
  for (const invalid of [
    null,
    'x'.repeat(8193),
    'é'.repeat(4097),
    '{}',
    ' ' + wire,
    wire.replace('"v":1', '"v":2'),
    wire.slice(0, -1) + ',"extra":true}',
    wire.slice(0, -1) + ',"v":1}',
  ]) {
    let calls = 0,
      closed = 0
    const inbox = new RtcProofInbox({
      paused: false,
      inspect: async () => {
        calls++
      },
      onReadonly: () => {
        closed++
      },
    })
    await inbox.receive(invalid)
    assert.equal(inbox.snapshot().state.kind, 'readonly')
    assert.equal(inbox.snapshot().work.retainedBytes, 0)
    assert.equal(calls, 0)
    assert.equal(closed, 1)
  }
})

test('application frame cap remains separate at2048 UTF8 bytes and does not authenticate', () => {
  assert.equal(boundRtcApplicationFrame('é'.repeat(1024)), 'é'.repeat(1024))
  assert.equal(boundRtcApplicationFrame('a'.repeat(2048)).length, 2048)
  for (const invalid of [
    null,
    new Uint8Array(1),
    'a'.repeat(2049),
    'é'.repeat(1025),
  ])
    assert.throws(() => boundRtcApplicationFrame(invalid))
})
