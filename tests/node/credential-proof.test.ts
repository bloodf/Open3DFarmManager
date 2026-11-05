import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  verify,
} from 'node:crypto'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import {
  CredentialProofChallenge,
  credentialProofPayload,
} from '../../packages/farm-protocol/src/credential-proof.ts'

function fixture() {
  const identity = new ConnectorIdentity(
    generateKeyPairSync('ed25519').privateKey,
  )
  const token = 'synthetic-bounded-credential'
  const challenge = CredentialProofChallenge.parse({
    v: 1,
    agent_id: randomUUID(),
    farm_id: randomUUID(),
    jti: randomUUID(),
    connection_id: randomUUID(),
    public_key_spki: identity.publicKeySpki,
    fingerprint: identity.fingerprint,
    thumbprint: randomBytes(32).toString('base64url'),
    token_hash: createHash('sha256').update(token).digest('base64url'),
    origin: 'https://farm.example',
    audience: 'open3dfarmmanager:connector',
    purpose: 'signalling',
    generation: 1,
    nonce: randomBytes(32).toString('base64url'),
    issued_at: 1000,
    expires_at: 31000,
  })
  const input = {
    challenge,
    token,
    expectedOrigin: challenge.origin,
    expectedAudience: challenge.audience,
    expectedPurpose: challenge.purpose,
    expectedConnectionId: challenge.connection_id,
    now: 1000,
  }
  return { identity, challenge, input }
}
test('live ConnectorIdentity signs exact credential domain and canonical context without exporting its key', () => {
  const { identity, challenge, input } = fixture()
  const signature = identity.signCredentialProof(input)
  const key = createPublicKey({
    key: Buffer.from(identity.publicKeySpki, 'base64url'),
    format: 'der',
    type: 'spki',
  })
  assert.equal(
    verify(
      null,
      credentialProofPayload(challenge),
      key,
      Buffer.from(signature, 'base64url'),
    ),
    true,
  )
  for (const patch of [
    { jti: randomUUID() },
    { farm_id: randomUUID() },
    { agent_id: randomUUID() },
    { connection_id: randomUUID() },
    { nonce: randomBytes(32).toString('base64url') },
    { purpose: 'telemetry-ingestion' },
    { generation: 2 },
    { origin: 'https://other.example' },
    { audience: 'other' },
    { token_hash: randomBytes(32).toString('base64url') },
  ]) {
    assert.equal(
      verify(
        null,
        credentialProofPayload({ ...challenge, ...patch }),
        key,
        Buffer.from(signature, 'base64url'),
      ),
      false,
    )
  }
  assert.equal(
    verify(
      null,
      Buffer.concat([
        Buffer.from('Open3DFarmManager/connector-proof/v1\0'),
        Buffer.from(challenge.nonce, 'base64url'),
      ]),
      key,
      Buffer.from(signature, 'base64url'),
    ),
    false,
  )
})
test('narrow signer denies wrong origin audience purpose connection token key and deadline', () => {
  const { identity, input } = fixture()
  const patches: Partial<typeof input>[] = [
    { expectedOrigin: 'https://other.example' },
    { expectedAudience: 'other' },
    { expectedPurpose: 'telemetry-ingestion' },
    { expectedConnectionId: randomUUID() },
    { token: 'other' },
    { now: 999 },
    { now: 31000 },
    { now: NaN },
  ]
  for (const patch of patches)
    assert.throws(() => identity.signCredentialProof({ ...input, ...patch }))
  assert.throws(() => fixture().identity.signCredentialProof(input))
})
test('strict credential challenges reject extra fields and unsafe or unbounded times', () => {
  const { challenge } = fixture()
  for (const patch of [
    { extra: true },
    { expires_at: 61001 },
    { expires_at: 1000 },
    { generation: 0 },
    { nonce: 'x'.repeat(43) },
    { origin: 'https://farm.example/' },
    { purpose: 'command' },
    { issued_at: Number.MAX_SAFE_INTEGER + 1 },
  ])
    assert.equal(
      CredentialProofChallenge.safeParse({ ...challenge, ...patch }).success,
      false,
    )
})
