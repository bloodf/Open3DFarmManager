import assert from 'node:assert/strict'
import test from 'node:test'
import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  verify,
} from 'node:crypto'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import {
  ControlSessionBinding,
  controlSessionProofPayload,
  decodeControlProof,
  encodeControlProof,
  verifyControlSessionProof,
} from '../../packages/farm-protocol/src/control-session-binding.ts'

async function fixture() {
  const key = generateKeyPairSync('ed25519')
  const identity = new ConnectorIdentity(key.privateKey)
  const browser = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const { kty, crv, x, y } = await crypto.subtle.exportKey(
    'jwk',
    browser.publicKey,
  )
  const validated = await validateBrowserDevicePublicKey({ kty, crv, x, y })
  const digest = () => randomBytes(32).toString('base64url')
  const binding = ControlSessionBinding.parse({
    v: 1,
    purpose: 'pause-rtc',
    transport_id: randomUUID(),
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    account_id: 'own-account',
    key_id: randomUUID(),
    assignment_id: randomUUID(),
    browser_public_key: validated.publicKey,
    browser_thumbprint: validated.thumbprint,
    connector_public_key_spki: identity.publicKeySpki,
    connector_fingerprint: identity.fingerprint,
    credential_jti: randomUUID(),
    origin: 'https://farm.example.test',
    audience: 'pause-fixture',
    browser_nonce: digest(),
    connector_nonce: digest(),
    issued_at: 1000,
    expires_at: 31000,
    offer_sha256: digest(),
    answer_sha256: digest(),
    browser_dtls: Array(32).fill('AB').join(':'),
    connector_dtls: Array(32).fill('CD').join(':'),
  })
  return { key, identity, binding }
}

test('encapsulated identity signs only the maintained Connector control domain', async () => {
  const { key, identity, binding } = await fixture()
  Object.defineProperty(key.privateKey, 'export', {
    value() {
      throw new Error('private export forbidden')
    },
  })
  const proof = await identity.signControlSessionProof({
    binding,
    expectedAgentId: binding.agent_id,
  })
  assert.equal(proof.role, 'connector')
  assert.deepEqual(decodeControlProof(encodeControlProof(proof)), proof)
  assert.equal(
    await verifyControlSessionProof(
      proof.binding,
      'connector',
      proof.signature,
    ),
    true,
  )
  const signature = Buffer.from(proof.signature, 'base64url')
  assert.equal(
    verify(
      null,
      controlSessionProofPayload(binding, 'connector'),
      key.publicKey,
      signature,
    ),
    true,
  )
  assert.equal(
    verify(
      null,
      controlSessionProofPayload(binding, 'browser'),
      key.publicKey,
      signature,
    ),
    false,
  )
  assert.equal(
    verify(
      null,
      Buffer.concat([
        Buffer.from('Open3DFarmManager/rtc-session-proof/v1\0'),
        controlSessionProofPayload(binding, 'connector'),
      ]),
      key.publicKey,
      signature,
    ),
    false,
  )
  assert.deepEqual(Object.keys(identity.toJSON()).sort(), [
    'algorithm',
    'fingerprint',
    'publicKeySpki',
  ])
})

test('control signer rejects foreign agent/key, malformed material and role injection', async () => {
  const { identity, binding } = await fixture()
  const foreign = await fixture()
  await assert.rejects(
    identity.signControlSessionProof({
      binding,
      expectedAgentId: randomUUID(),
    }),
  )
  await assert.rejects(
    identity.signControlSessionProof({ binding, expectedAgentId: 'untrusted' }),
  )
  for (const patch of [
    {
      connector_public_key_spki: foreign.identity.publicKeySpki,
      connector_fingerprint: foreign.identity.fingerprint,
    },
    { connector_fingerprint: foreign.identity.fingerprint },
    { browser_thumbprint: randomBytes(32).toString('base64url') },
    {
      browser_public_key: {
        ...binding.browser_public_key,
        x: 'A'.repeat(43),
        y: 'A'.repeat(43),
      },
    },
    { purpose: 'readonly-rtc' },
    { v: 2 },
    { expires_at: 31001 },
  ])
    await assert.rejects(
      identity.signControlSessionProof({
        binding: { ...binding, ...patch },
        expectedAgentId: binding.agent_id,
      }),
    )
  const injected = {
    binding,
    expectedAgentId: binding.agent_id,
    role: 'browser',
  }
  await assert.rejects(identity.signControlSessionProof(injected))
  assert.throws(() =>
    identity.signRtcSessionProof({
      binding,
      expectedAgentId: binding.agent_id,
    }),
  )
})

test('control signer snapshots input before await and derives identity from its private key', async () => {
  const { identity, binding } = await fixture()
  const original = structuredClone(binding)
  const input = { binding, expectedAgentId: binding.agent_id }
  const pending = identity.signControlSessionProof(input)
  input.expectedAgentId = randomUUID()
  binding.agent_id = randomUUID()
  binding.browser_public_key.x = 'A'.repeat(43)
  const proof = await pending
  assert.deepEqual(proof.binding, original)
  assert.equal(
    await verifyControlSessionProof(
      proof.binding,
      'connector',
      proof.signature,
    ),
    true,
  )
  const foreign = await fixture()
  Object.defineProperty(identity, 'publicKeySpki', {
    value: foreign.identity.publicKeySpki,
  })
  Object.defineProperty(identity, 'fingerprint', {
    value: foreign.identity.fingerprint,
  })
  await assert.rejects(
    identity.signControlSessionProof({
      binding: {
        ...original,
        connector_public_key_spki: foreign.identity.publicKeySpki,
        connector_fingerprint: foreign.identity.fingerprint,
      },
      expectedAgentId: original.agent_id,
    }),
  )
  const own = await identity.signControlSessionProof({
    binding: original,
    expectedAgentId: original.agent_id,
  })
  assert.equal(
    await verifyControlSessionProof(own.binding, 'connector', own.signature),
    true,
  )
})
