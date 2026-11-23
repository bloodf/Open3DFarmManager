import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { issueConnectorCredential } from '../../apps/farm/server/utils/connector-credentials.ts'
import { createConnectorLibraryAuthenticator } from '../../apps/farm/server/utils/library/connector-download.ts'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'

// #580: a valid bearer credential alone must not open the Connector library
// download or relay; the request must carry a fresh proof signed by the
// enrolled Connector key.
async function fixture() {
  const issuer = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const connector = new ConnectorIdentity(
    generateKeyPairSync('ed25519').privateKey,
  )
  const stranger = new ConnectorIdentity(
    generateKeyPairSync('ed25519').privateKey,
  )
  const agentId = randomUUID()
  const farmId = randomUUID()
  const policy = {
    issuer: 'https://farm.test',
    audience: 'connector-telemetry',
    ttlSeconds: 600,
  }
  const token = await issueConnectorCredential({
    ...policy,
    kid: 'k1',
    privateKey: issuer.privateKey,
    agentId,
    farmId,
    publicKeySpki: connector.publicKeySpki,
    nowSeconds: Math.floor(Date.now() / 1000),
    jti: randomUUID(),
  })
  const authenticate = createConnectorLibraryAuthenticator({
    credentials: {
      ...policy,
      publicKeys: new Map([['k1', issuer.publicKey]]),
    },
    enrollments: {
      async find(farm, agent) {
        return farm === farmId && agent === agentId
          ? { status: 'approved', publicKeySpki: connector.publicKeySpki }
          : null
      },
    },
  })
  const bearer = {
    authorization: `Bearer ${token}`,
    'x-connector-agent': agentId,
    'x-connector-farm': farmId,
  }
  const proof = (signer = connector, at = Date.now(), forToken = token) =>
    signer.signLibraryProof({ token: forToken, agentId, farmId, now: at })
  return { authenticate, bearer, proof, stranger, agentId, farmId, token }
}

test('a valid bearer without a proof of possession is refused', async () => {
  const f = await fixture()
  assert.equal(await f.authenticate(new Headers(f.bearer)), null)
})

test('a valid bearer with a wrong or tampered signature is refused', async () => {
  const f = await fixture()
  const foreign = f.proof(f.stranger)
  assert.equal(
    await f.authenticate(new Headers({ ...f.bearer, ...foreign })),
    null,
  )
  const good = f.proof()
  const other = f.proof()
  assert.equal(
    await f.authenticate(
      new Headers({
        ...f.bearer,
        'x-connector-proof': good['x-connector-proof']!,
        'x-connector-proof-signature': other['x-connector-proof-signature']!,
      }),
    ),
    null,
  )
  assert.equal(
    await f.authenticate(
      new Headers({
        ...f.bearer,
        'x-connector-proof-signature': 'A'.repeat(86),
      }),
    ),
    null,
  )
})

test('a proof that is expired, for another token, or replayed is refused', async () => {
  const f = await fixture()
  assert.equal(
    await f.authenticate(
      new Headers({ ...f.bearer, ...f.proof(undefined, Date.now() - 120_000) }),
    ),
    null,
  )
  assert.equal(
    await f.authenticate(
      new Headers({
        ...f.bearer,
        ...f.proof(undefined, Date.now(), f.token + 'x'),
      }),
    ),
    null,
  )
  const once = f.proof()
  assert.deepEqual(
    await f.authenticate(new Headers({ ...f.bearer, ...once })),
    {
      agentId: f.agentId,
      farmId: f.farmId,
    },
  )
  assert.equal(
    await f.authenticate(new Headers({ ...f.bearer, ...once })),
    null,
  )
})

test('the Connector signature from the enrolled key is accepted', async () => {
  const f = await fixture()
  assert.deepEqual(
    await f.authenticate(new Headers({ ...f.bearer, ...f.proof() })),
    { agentId: f.agentId, farmId: f.farmId },
  )
})
