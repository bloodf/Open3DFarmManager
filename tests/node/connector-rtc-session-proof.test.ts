import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { canonicalize } from '../../packages/farm-protocol/src/canonical.ts'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import {
  RtcSessionBinding,
  ConnectorRtcProof,
  verifyRtcSessionProof,
  rtcSessionProofPayload,
  encodeRtcProof,
  decodeRtcProof,
  MAX_RTC_PROOF_WIRE_BYTES,
} from '../../packages/farm-protocol/src/rtc-session-binding.ts'

async function fixture() {
  const privateKey = generateKeyPairSync('ed25519').privateKey
  // Fail if the signer tries to export or convert this private KeyObject.
  Object.defineProperty(privateKey, 'export', {
    value: () => {
      throw Error('Private key export forbidden')
    },
  })
  const identity = new ConnectorIdentity(privateKey)
  const browser = await validateBrowserDevicePublicKey(
    generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({
      format: 'jwk',
    }),
  )
  const expectedAgentId = randomUUID()
  const digest = () => randomBytes(32).toString('base64url')
  const binding = RtcSessionBinding.parse({
    v: 1,
    purpose: 'read-only-rtc',
    transport_id: randomUUID(),
    farm_id: randomUUID(),
    agent_id: expectedAgentId,
    account_id: 'synthetic_account',
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
  })
  return { identity, binding, expectedAgentId }
}

test('v1 bytes remain exact; v2 envelope and domain cannot be downgraded', async () => {
  const { identity, binding, expectedAgentId } = await fixture()
  assert.equal(
    new TextDecoder().decode(rtcSessionProofPayload(binding, 'connector')),
    'Open3DFarmManager/rtc-session-proof/v1\0connector\0' +
      canonicalize(binding),
  )
  const v2 = RtcSessionBinding.parse({
    ...binding,
    v: 2,
    assignment_count: 16,
    assignment_digest: randomBytes(32).toString('base64url'),
  })
  const proof = identity.signRtcSessionProof({ binding: v2, expectedAgentId })
  assert.equal(proof.v, 2)
  assert.equal(
    new TextDecoder().decode(rtcSessionProofPayload(v2, 'connector')),
    'Open3DFarmManager/rtc-session-proof/v2\0connector\0' + canonicalize(v2),
  )
  assert.equal(
    await verifyRtcSessionProof(v2, 'connector', proof.signature),
    true,
  )
  assert.equal(
    await verifyRtcSessionProof(binding, 'connector', proof.signature),
    false,
  )
  assert.equal(
    await verifyRtcSessionProof(v2, 'browser', proof.signature),
    false,
  )
  assert.throws(() => ConnectorRtcProof.parse({ ...proof, v: 1 }))
  assert.throws(() => ConnectorRtcProof.parse({ ...proof, binding }))
  assert.equal(
    await verifyRtcSessionProof(
      { ...v2, assignment_count: 15 },
      'connector',
      proof.signature,
    ),
    false,
  )
  assert.equal(
    await verifyRtcSessionProof(
      { ...v2, assignment_digest: randomBytes(32).toString('base64url') },
      'connector',
      proof.signature,
    ),
    false,
  )
  const wire = encodeRtcProof(proof)
  assert.deepEqual(decodeRtcProof(wire), proof)
  assert.ok(Buffer.byteLength(wire) <= MAX_RTC_PROOF_WIRE_BYTES)
})

test('encapsulated identity returns a strict Connector proof verified by the real protocol without private export', async () => {
  const { identity, binding, expectedAgentId } = await fixture()
  const proof = identity.signRtcSessionProof({ binding, expectedAgentId })
  assert.deepEqual(ConnectorRtcProof.parse(proof), proof)
  assert.equal(proof.role, 'connector')
  assert.equal(proof.signature.length, 86)
  assert.equal(
    await verifyRtcSessionProof(binding, 'connector', proof.signature),
    true,
  )
  assert.equal(
    await verifyRtcSessionProof(binding, 'browser', proof.signature),
    false,
  )
  for (const patch of [
    { agent_id: randomUUID() },
    { transport_id: randomUUID() },
    { offer_sha256: randomBytes(32).toString('base64url') },
    { connector_nonce: randomBytes(32).toString('base64url') },
  ])
    assert.equal(
      await verifyRtcSessionProof(
        { ...binding, ...patch },
        'connector',
        proof.signature,
      ),
      false,
    )
  assert.deepEqual(identity.toJSON(), {
    algorithm: 'Ed25519',
    fingerprint: identity.fingerprint,
    publicKeySpki: identity.publicKeySpki,
  })
  assert.equal(
    Object.getOwnPropertyNames(identity).some((name) =>
      /private|keyobject/i.test(name),
    ),
    false,
  )
})

test('signer refuses wrong trusted agent, foreign key or fingerprint, role injection and malformed binding', async () => {
  const { identity, binding, expectedAgentId } = await fixture()
  const other = await fixture()
  for (const expected of [
    '',
    'not-a-uuid',
    randomUUID(),
    expectedAgentId.toUpperCase(),
  ])
    assert.throws(() =>
      identity.signRtcSessionProof({ binding, expectedAgentId: expected }),
    )
  for (const patch of [
    { agent_id: randomUUID() },
    { connector_public_key_spki: other.identity.publicKeySpki },
    { connector_fingerprint: other.identity.fingerprint },
    { role: 'browser' },
    { purpose: 'command' },
    { commands_enabled: true },
    { expires_at: 1000 },
    { expires_at: 31001 },
    { issued_at: 1.5 },
    { browser_nonce: 'bad' },
    { extra: 'untrusted' },
  ])
    assert.throws(() =>
      identity.signRtcSessionProof({
        binding: { ...binding, ...patch },
        expectedAgentId,
      }),
    )
  for (const invalid of [null, 'arbitrary bytes', new Uint8Array(32)])
    assert.throws(() =>
      identity.signRtcSessionProof({ binding: invalid, expectedAgentId }),
    )
  const roleInjected = { binding, expectedAgentId, role: 'browser' }
  assert.throws(() => identity.signRtcSessionProof(roleInjected))
  assert.throws(() =>
    other.identity.signRtcSessionProof({ binding, expectedAgentId }),
  )
})
