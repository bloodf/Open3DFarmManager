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
import {
  TelemetryProofChallenge,
  telemetryProofPayload,
  TELEMETRY_OPERATION_PATH,
} from '../../packages/farm-protocol/src/telemetry-proof.ts'
import { prepareTelemetryOperation } from '../../apps/farm/server/services/telemetry-operation.ts'
function fixture() {
  const identity = new ConnectorIdentity(
    generateKeyPairSync('ed25519').privateKey,
  )
  const event = {
    eventId: randomUUID(),
    queuedAt: 1000,
    kind: 'printer-state',
    state: {
      printerKey: 'impressora-á',
      state: 'idle',
      progress: 0,
      observedAt: 1000,
    },
  }
  const body = Buffer.from(JSON.stringify([event]))
  const operation = prepareTelemetryOperation(body)
  const token = 'synthetic-bounded-token'
  const challenge = TelemetryProofChallenge.parse({
    v: 2,
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
    purpose: 'telemetry-ingestion',
    generation: 1,
    nonce: randomBytes(32).toString('base64url'),
    issued_at: 1000,
    expires_at: 31000,
    method: operation.method,
    path: operation.path,
    body_sha256: operation.bodyHash,
    body_bytes: operation.bodyBytes,
  })
  return {
    identity,
    event,
    body,
    operation,
    challenge,
    input: {
      challenge,
      token,
      body,
      expectedOrigin: challenge.origin,
      expectedAudience: challenge.audience,
      expectedConnectionId: challenge.connection_id,
      now: 1000,
    },
  }
}
test('telemetry proof signs exact bytes, POST/path/context and a separate strict versioned domain', () => {
  const { identity, body, challenge, input } = fixture()
  const signature = Buffer.from(identity.signTelemetryProof(input), 'base64url')
  const key = createPublicKey({
    key: Buffer.from(identity.publicKeySpki, 'base64url'),
    format: 'der',
    type: 'spki',
  })
  assert.equal(
    verify(null, telemetryProofPayload(challenge), key, signature),
    true,
  )
  const { method, path, body_sha256, body_bytes, ...base } = challenge
  const generic = CredentialProofChallenge.parse({ ...base, v: 1 })
  assert.equal(
    verify(null, credentialProofPayload(generic), key, signature),
    false,
  )
  assert.equal(CredentialProofChallenge.safeParse(challenge).success, false)
  assert.equal(TelemetryProofChallenge.safeParse(generic).success, false)
  for (const patch of [
    { body_sha256: randomBytes(32).toString('base64url') },
    { body_bytes: body.length + 1 },
    { connection_id: randomUUID() },
    { generation: 2 },
    { nonce: randomBytes(32).toString('base64url') },
  ])
    assert.equal(
      verify(
        null,
        telemetryProofPayload({ ...challenge, ...patch }),
        key,
        signature,
      ),
      false,
    )
  for (const patch of [
    { v: 1 },
    { method: 'GET' },
    { path: TELEMETRY_OPERATION_PATH + '?x=1' },
    { path: '/api/other' },
    { purpose: 'signalling' },
    { body_bytes: 65537 },
    { body_bytes: 0 },
    { extra: true },
  ])
    assert.equal(
      TelemetryProofChallenge.safeParse({ ...challenge, ...patch }).success,
      false,
    )
})
test('narrow telemetry signer rejects changed bytes, trust, key and deadline before signing', () => {
  const { identity, input, body } = fixture()
  for (const patch of [
    { body: Buffer.concat([body, Buffer.from(' ')]) },
    { token: 'other' },
    { expectedOrigin: 'https://other.example' },
    { expectedAudience: 'other' },
    { expectedConnectionId: randomUUID() },
    { now: 999 },
    { now: 31000 },
    { body: Buffer.alloc(65537) },
  ])
    assert.throws(() => identity.signTelemetryProof({ ...input, ...patch }))
  assert.throws(() => fixture().identity.signTelemetryProof(input))
})
test('body snapshot preserves raw-byte binding, bounds parsing and rejects invalid printer encodings', () => {
  const { body, operation, event } = fixture()
  const snapshot = prepareTelemetryOperation(body)
  body.fill(0)
  assert.deepEqual(snapshot, operation)
  const compact = Buffer.from(JSON.stringify([event])),
    pretty = Buffer.from(JSON.stringify([event], null, 2))
  const a = prepareTelemetryOperation(compact),
    b = prepareTelemetryOperation(pretty)
  assert.deepEqual(a.records, b.records)
  assert.notEqual(a.bodyHash, b.bodyHash)
  assert.equal(a.bodyBytes, compact.byteLength)
  for (const input of [
    Buffer.alloc(0),
    Buffer.alloc(65537),
    Buffer.from([0xff]),
    Buffer.from('[]'),
    Buffer.from(JSON.stringify([event, event])),
    Buffer.from(
      JSON.stringify([
        { ...event, state: { ...event.state, printerKey: 'bad\0' } },
      ]),
    ),
    Buffer.from(
      JSON.stringify([
        { ...event, state: { ...event.state, printerKey: 'bad\ud800' } },
      ]),
    ),
  ])
    assert.throws(() => prepareTelemetryOperation(input))
})
