import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import { AuthenticatedConnectorSignallingClient } from '../../packages/connector/src/cloud/authenticated-signalling-client.ts'
import { AuthenticatedBrowserSignallingClient } from '../../apps/farm/app/utils/webrtc/authenticated-signalling-client.ts'

/** Pure projection checks only: no sockets, child process, or native RTC imports. */
test('unstarted and terminal Connector diagnostics are bounded immutable nonsecret projections', () => {
  const client = new AuthenticatedConnectorSignallingClient({
    url: 'wss://farm.example/api/signalling/connector',
    origin: 'https://farm.example',
    audience: 'test-audience',
    agentId: randomUUID(),
    farmId: randomUUID(),
    jti: randomUUID(),
    token: 'private-test-token',
    identity: new ConnectorIdentity(generateKeyPairSync('ed25519').privateKey),
  })
  try {
    const before = client.diagnostics()
    assert.deepEqual(before, {
      certificateMatched: false,
      sentProofs: 0,
      receivedProofs: 0,
      terminal: false,
      readOnly: true,
    })
    assert.equal(Object.isFrozen(before), true)
    assert.deepEqual(Object.keys(before).sort(), [
      'certificateMatched',
      'readOnly',
      'receivedProofs',
      'sentProofs',
      'terminal',
    ])
    client.close()
    assert.deepEqual(client.diagnostics(), { ...before, terminal: true })
    assert.equal(before.terminal, false)
  } finally {
    client.close()
  }
})

test('browser diagnostics require an actual adopted peer and never expose credentials or key scope', async () => {
  const keys = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
  let factoryCalls = 0
  const client = new AuthenticatedBrowserSignallingClient(
    {
      farmId: randomUUID(),
      agentId: randomUUID(),
      keyId: randomUUID(),
      accountId: 'private-test-account',
      origin: 'https://farm.example',
      audience: 'test-audience',
      privateKey: keys.privateKey,
      publicKey: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
    },
    {
      peerFactory: () => {
        factoryCalls++
        throw Error('must not run')
      },
    },
  )
  try {
    const before = client.diagnostics()
    assert.deepEqual(before, {
      certificateMatched: false,
      sentProofs: 0,
      receivedProofs: 0,
      terminal: false,
      readOnly: true,
    })
    assert.equal(Object.isFrozen(before), true)
    client.close()
    assert.deepEqual(client.diagnostics(), { ...before, terminal: true })
    assert.equal(factoryCalls, 0)
  } finally {
    client.close()
  }
})
