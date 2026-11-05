import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import { AuthenticatedBrowserSignallingClient } from '../../apps/farm/app/utils/webrtc/authenticated-signalling-client.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import { verifyBrowserTransportProof } from '../../packages/farm-protocol/src/browser-transport-proof.ts'
import type { SocketPort } from '../../packages/connector/src/webrtc/signalling-client-channel.ts'

async function fixture(mutate = false) {
  const key = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const jwk = await crypto.subtle.exportKey('jwk', key.publicKey)
  const publicKey = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }
  const thumbprint = (await validateBrowserDevicePublicKey(publicKey))
    .thumbprint
  const scope = {
    farmId: randomUUID(),
    agentId: randomUUID(),
    keyId: randomUUID(),
    accountId: 'account_test',
    origin: 'https://farm.example',
    audience: 'farm-test',
    publicKey,
    privateKey: key.privateKey,
  }
  const now = Date.now()
  const challenge = {
    v: 1 as const,
    purpose: 'signalling-admission' as const,
    transport_id: randomUUID(),
    farm_id: scope.farmId,
    agent_id: scope.agentId,
    key_id: scope.keyId,
    account_id: scope.accountId,
    thumbprint,
    origin: scope.origin,
    audience: scope.audience,
    nonce: randomBytes(32).toString('base64url'),
    issued_at: now - 10,
    expires_at: now + 5000,
  }
  let handlers: Parameters<SocketPort['bind']>[0] | undefined
  const sent: string[] = []
  let closed = 0
  const socket: SocketPort = {
    isOpen: () => true,
    bufferedBytes: () => 0,
    send: (wire, done) => {
      sent.push(wire)
      done()
    },
    bind: (h) => {
      handlers = h
      return () => {
        handlers = undefined
      }
    },
    close: () => {
      closed++
    },
  }
  let binding: Promise<unknown> | undefined
  let peerClosed = 0
  let verified: (() => void) | undefined
  const answer = `v=0\r\na=fingerprint:sha-256 ${Array(32).fill('BB').join(':')}\r\n`
  const client = new AuthenticatedBrowserSignallingClient(scope, {
    peerFactory: (options) => {
      binding = options.admittedBinding
      verified = options.onVerified
      return {
        answer: async () => answer,
        close: () => {
          peerClosed++
        },
      }
    },
  })
  if (mutate) {
    scope.farmId = randomUUID()
    scope.agentId = randomUUID()
    scope.accountId = 'other_account'
    scope.keyId = randomUUID()
  }
  const pending = client.start(() => socket)
  assert.equal(
    client.start(() => {
      throw Error('second socket')
    }),
    pending,
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  handlers?.open()
  await new Promise((resolve) => setTimeout(resolve, 0))
  return {
    scope,
    challenge,
    sent,
    client,
    push: (value: unknown) => handlers?.message(JSON.stringify(value)),
    closed: () => closed,
    peerClosed: () => peerClosed,
    binding: () => binding,
    answer,
    pending,
    verify: () => verified?.(),
  }
}
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw Error('test deadline')
}

test('browser signs only the matching challenge with its nonextractable key', async () => {
  const f = await fixture()
  try {
    assert.equal(JSON.parse(f.sent[0]!).t, 'browser.begin')
    f.push({ v: 1, t: 'browser.challenge', challenge: f.challenge })
    await waitFor(() => f.sent.length === 2)
    const proof = JSON.parse(f.sent[1]!)
    assert.equal(proof.t, 'browser.proof')
    assert.equal(
      await verifyBrowserTransportProof(
        f.challenge,
        f.scope.publicKey,
        proof.signature,
      ),
      true,
    )
  } finally {
    f.client.close()
  }
  assert.equal(f.closed(), 1)
})
test('wrong scope and out-of-order server messages close without signing', async () => {
  for (const frame of ['scope', 'order'] as const) {
    const f = await fixture()
    try {
      f.push(
        frame === 'scope'
          ? {
              v: 1,
              t: 'browser.challenge',
              challenge: { ...f.challenge, agent_id: randomUUID() },
            }
          : {
              v: 1,
              t: 'rtc.ready',
              transport_id: f.challenge.transport_id,
              issued_at: Date.now() - 1,
              expires_at: Date.now() + 1000,
              commands_enabled: false,
            },
      )
      await waitFor(() => f.client.snapshot().state === 'readonly')
      assert.equal(f.sent.length, 1)
    } finally {
      f.client.close()
    }
    assert.equal(f.closed(), 1)
  }
})

test('ordered ready and offer deliver only the scoped admitted binding', async () => {
  const f = await fixture()
  try {
    f.push({ v: 1, t: 'browser.challenge', challenge: f.challenge })
    await waitFor(() => f.sent.length === 2)
    const now = Date.now()
    f.push({
      v: 1,
      t: 'rtc.ready',
      transport_id: f.challenge.transport_id,
      issued_at: now - 1,
      expires_at: now + 4000,
      commands_enabled: false,
    })
    const offer = `v=0\r\na=fingerprint:sha-256 ${Array(32).fill('AA').join(':')}\r\n`
    f.push({
      v: 1,
      t: 'rtc.offer',
      transport_id: f.challenge.transport_id,
      seq: 0,
      p: { sdp: offer },
    })
    await waitFor(() => f.sent.length === 3)
    assert.equal(JSON.parse(f.sent[2]!).t, 'rtc.answer')
    const connector = new ConnectorIdentity(
      generateKeyPairSync('ed25519').privateKey,
    )
    const nonce = () => randomBytes(32).toString('base64url')
    const binding = {
      v: 1,
      purpose: 'read-only-rtc',
      transport_id: f.challenge.transport_id,
      farm_id: f.scope.farmId,
      agent_id: f.scope.agentId,
      account_id: f.scope.accountId,
      key_id: f.scope.keyId,
      browser_public_key: f.scope.publicKey,
      browser_thumbprint: f.challenge.thumbprint,
      connector_public_key_spki: connector.publicKeySpki,
      connector_fingerprint: connector.fingerprint,
      credential_jti: randomUUID(),
      origin: f.scope.origin,
      audience: f.scope.audience,
      browser_nonce: f.challenge.nonce,
      connector_nonce: nonce(),
      issued_at: now - 1,
      expires_at: now + 4000,
      commands_enabled: false,
      offer_sha256: nonce(),
      answer_sha256: nonce(),
      browser_dtls: Array(32).fill('BB').join(':'),
      connector_dtls: Array(32).fill('AA').join(':'),
    }
    f.push({ v: 1, t: 'rtc.binding', binding })
    await waitFor(() => f.binding() !== undefined)
    assert.deepEqual(await f.binding(), binding)
    let settled = false
    void f.pending.then(() => {
      settled = true
    })
    await Promise.resolve()
    assert.equal(settled, false)
    f.verify()
    await f.pending
    assert.equal(settled, true)
  } finally {
    f.client.close()
  }
  assert.equal(f.peerClosed(), 1)
})

test('caller mutation cannot alter begin or trusted challenge context', async () => {
  const f = await fixture(true)
  try {
    const begin = JSON.parse(f.sent[0]!)
    assert.equal(begin.farm_id, f.challenge.farm_id)
    assert.equal(begin.agent_id, f.challenge.agent_id)
    assert.equal(begin.key_id, f.challenge.key_id)
    f.push({ v: 1, t: 'browser.challenge', challenge: f.challenge })
    await waitFor(() => f.sent.length === 2)
    assert.equal(f.client.snapshot().state, 'pending')
  } finally {
    f.client.close()
  }
  await assert.rejects(f.pending)
})

test('closed client ignores late frames and does not affect another account', async () => {
  const a = await fixture(),
    b = await fixture()
  try {
    a.client.close()
    a.push({ v: 1, t: 'browser.challenge', challenge: a.challenge })
    b.push({
      v: 1,
      t: 'browser.challenge',
      challenge: {
        ...b.challenge,
        account_id: a.challenge.account_id,
        farm_id: a.challenge.farm_id,
      },
    })
    await waitFor(() => b.client.snapshot().state === 'readonly')
    assert.equal(a.sent.length, 1)
    assert.equal(b.sent.length, 1)
    await assert.rejects(a.pending)
    await assert.rejects(b.pending)
  } finally {
    a.client.close()
    b.client.close()
  }
})
