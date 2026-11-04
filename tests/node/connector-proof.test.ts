import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync, sign } from 'node:crypto'
import { ConnectorProofChallenges } from '../../apps/farm/server/services/connector-proof.ts'
import {
  ConnectorIdentity,
  loadOrCreateIdentity,
  loadExistingIdentity,
} from '../../packages/connector/src/identity/store.ts'
const id = '00000000-0000-4000-8000-000000000001'
const other = '00000000-0000-4000-8000-000000000002'
function fixture() {
  const key = generateKeyPairSync('ed25519').privateKey
  const identity = new ConnectorIdentity(key)
  const binding = {
    farmId: id,
    agentId: id,
    connectionId: id,
    publicKeySpki: identity.publicKeySpki,
    fingerprint: identity.fingerprint,
    revoked: false,
  }
  return { identity, binding, key }
}

test('persisted Connector identity answers server challenge once after identity reload', () => {
  const directory = mkdtempSync(join(tmpdir(), 'open3d-proof-'))
  try {
    const first = loadOrCreateIdentity(directory)
    const identity = loadExistingIdentity(directory)
    const server = new ConnectorProofChallenges()
    const binding = {
      farmId: id,
      agentId: id,
      connectionId: id,
      publicKeySpki: first.publicKeySpki,
      fingerprint: first.fingerprint,
      revoked: false,
    }
    const challenge = server.issue(binding, 1000, 5000)
    const proof = identity.signProof(Buffer.from(challenge.nonce, 'base64url'))
    assert.equal(server.complete(challenge.nonce, proof, binding, 1001), true)
    assert.equal(server.complete(challenge.nonce, proof, binding, 1001), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
test('changed farm, agent, connection, key and revocation fail and consume the attempt', () => {
  const { identity, binding } = fixture()
  const alternate = fixture()
  for (const patch of [
    { farmId: other },
    { agentId: other },
    { connectionId: other },
    { revoked: true },
    {
      publicKeySpki: alternate.identity.publicKeySpki,
      fingerprint: alternate.identity.fingerprint,
    },
  ]) {
    const server = new ConnectorProofChallenges()
    const challenge = server.issue(binding, 1000, 5000)
    const proof = identity.signProof(Buffer.from(challenge.nonce, 'base64url'))
    assert.equal(
      server.complete(challenge.nonce, proof, { ...binding, ...patch }, 1001),
      false,
    )
    assert.equal(server.complete(challenge.nonce, proof, binding, 1001), false)
  }
})
test('wrong key, wrong domain and malformed signatures cannot complete a challenge', () => {
  const { identity, binding, key } = fixture()
  const alternate = fixture()
  for (const makeProof of [
    (nonce: Buffer) => alternate.identity.signProof(nonce),
    (nonce: Buffer) => sign(null, nonce, key).toString('base64url'),
    (_nonce: Buffer) => 'A'.repeat(85) + 'B',
    (_nonce: Buffer) => 'invalid',
  ]) {
    const server = new ConnectorProofChallenges()
    const challenge = server.issue(binding, 1000, 5000)
    const bytes = Buffer.from(challenge.nonce, 'base64url')
    assert.equal(
      server.complete(challenge.nonce, makeProof(bytes), binding, 1001),
      false,
    )
    assert.equal(
      server.complete(
        challenge.nonce,
        identity.signProof(bytes),
        binding,
        1001,
      ),
      false,
    )
  }
})
test('expiry is exclusive, clock rollback rejects, and restarting the registry invalidates pending challenges', () => {
  const { identity, binding } = fixture()
  const server = new ConnectorProofChallenges()
  const challenge = server.issue(binding, 1000, 5000)
  const proof = identity.signProof(Buffer.from(challenge.nonce, 'base64url'))
  assert.equal(server.complete(challenge.nonce, proof, binding, 999), false)
  assert.equal(server.complete(challenge.nonce, proof, binding, 6000), false)
  assert.equal(
    new ConnectorProofChallenges().complete(
      challenge.nonce,
      proof,
      binding,
      1001,
    ),
    false,
  )
})
test('capacity, invalid binding and invalid issuance times fail closed without rotating the identity', () => {
  const { binding } = fixture()
  const server = new ConnectorProofChallenges(1)
  assert.throws(
    () => server.issue({ ...binding, fingerprint: 'invalid' }, 1000, 5000),
    /unavailable/,
  )
  assert.throws(
    () => server.issue({ ...binding, revoked: true }, 1000, 5000),
    /unavailable/,
  )
  for (const ttl of [0, -1, 1.5, NaN, 60001])
    assert.throws(() => server.issue(binding, 1000, ttl), /unavailable/)
  server.issue(binding, 1000, 5000)
  assert.throws(() => server.issue(binding, 1000, 5000), /unavailable/)
  assert.equal(server.issue(binding, 6000, 5000).expiresAt, 11000)
})
test('binding snapshots cannot be mutated by the caller and disconnect invalidates challenges', () => {
  const { identity, binding } = fixture()
  const server = new ConnectorProofChallenges()
  const input = { ...binding }
  const challenge = server.issue(input, 1000, 5000)
  input.farmId = other
  const proof = identity.signProof(Buffer.from(challenge.nonce, 'base64url'))
  assert.equal(server.complete(challenge.nonce, proof, binding, 1001), true)
  const next = server.issue(binding, 1001, 5000)
  server.discardConnection(binding.connectionId)
  assert.equal(
    server.complete(
      next.nonce,
      identity.signProof(Buffer.from(next.nonce, 'base64url')),
      binding,
      1002,
    ),
    false,
  )
})

test('two completions of the same challenge yield exactly one success', async () => {
  const { identity, binding } = fixture()
  const server = new ConnectorProofChallenges()
  const challenge = server.issue(binding, 1000, 5000)
  const proof = identity.signProof(Buffer.from(challenge.nonce, 'base64url'))
  const results = await Promise.all(
    Array.from({ length: 2 }, async () =>
      server.complete(challenge.nonce, proof, binding, 1001),
    ),
  )
  assert.equal(results.filter(Boolean).length, 1)
})
