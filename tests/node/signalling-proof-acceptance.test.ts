import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { acceptSignallingProof } from '../../apps/farm/server/services/signalling-proof-acceptance.ts'
import {
  connectorKeyBinding,
  issueConnectorCredential,
} from '../../apps/farm/server/utils/connector-credentials.ts'
import {
  CredentialProofChallenge,
  credentialProofPayload,
} from '../../packages/farm-protocol/src/credential-proof.ts'
import { base64url } from '../../packages/farm-protocol/src/encoding.ts'
import type { CredentialAcceptanceDecision } from '../../apps/farm/server/storage/postgres-connector-credential-acceptance.ts'
async function proof() {
  const connector = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const issuer = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const spki = base64url(
    new Uint8Array(await crypto.subtle.exportKey('spki', connector.publicKey)),
  )
  const binding = await connectorKeyBinding(spki)
  const agentId = randomUUID(),
    farmId = randomUUID(),
    jti = randomUUID(),
    connectionId = randomUUID()
  const now = Date.now()
  const token = await issueConnectorCredential({
    issuer: 'independent-signalling-fixture',
    audience: 'fixture',
    kid: 'fixture',
    privateKey: issuer.privateKey,
    ttlSeconds: 60,
    nowSeconds: Math.floor(now / 1000),
    agentId,
    farmId,
    jti,
    publicKeySpki: spki,
  })
  const challenge = CredentialProofChallenge.parse({
    v: 1,
    agent_id: agentId,
    farm_id: farmId,
    jti,
    connection_id: connectionId,
    public_key_spki: spki,
    fingerprint: binding.fingerprint,
    thumbprint: binding.thumbprint,
    token_hash: createHash('sha256').update(token).digest('base64url'),
    origin: 'https://farm.example',
    audience: 'fixture',
    purpose: 'signalling',
    generation: 1,
    nonce: randomBytes(32).toString('base64url'),
    issued_at: now,
    expires_at: now + 8000,
  })
  const signature = base64url(
    new Uint8Array(
      await crypto.subtle.sign(
        'Ed25519',
        connector.privateKey,
        new Uint8Array(credentialProofPayload(challenge)),
      ),
    ),
  )
  return {
    request: { token, agentId, farmId, connectionId, challenge, signature },
    accepted: {
      ok: true,
      kind: 'accepted',
      agentId,
      farmId,
      jti,
      connectionId,
      purpose: 'signalling',
      acceptedAt: now,
      expiresAt: now + 8000,
    } satisfies CredentialAcceptanceDecision,
  }
}
const nativeTimers = {
  after(ms: number, callback: () => void) {
    const timer = setTimeout(callback, ms)
    return () => clearTimeout(timer)
  },
}
test('real 1000ms completion throttle retries the exact frozen proof without reissuance', async () => {
  const fixture = await proof(),
    controller = new AbortController()
  const nextAttempt = Date.now() + 1000
  let calls = 0,
    pinned: unknown
  const result = await acceptSignallingProof({
    request: fixture.request,
    clock: { monotonic: () => performance.now() },
    timers: nativeTimers,
    deadline: performance.now() + 8000,
    signal: controller.signal,
    credentials: {
      async accept(input: unknown): Promise<CredentialAcceptanceDecision> {
        calls++
        assert.equal(
          createHash('sha256').update(JSON.stringify(input)).digest('hex'),
          createHash('sha256')
            .update(JSON.stringify(fixture.request))
            .digest('hex'),
        )
        assert.equal(Object.isFrozen(input), true)
        if (calls === 1) pinned = input
        else assert.equal(input, pinned)
        const remaining = nextAttempt - Date.now()
        return remaining > 0
          ? { ok: false, reason: 'busy', retryAfterMs: remaining }
          : fixture.accepted
      },
    },
  })
  assert.equal(Date.now() >= nextAttempt, true)
  assert.ok(calls >= 2 && calls <= 3)
  assert.deepEqual(result, fixture.accepted)
})
test('insufficient original deadline and retry cap deny without extending authority', async () => {
  const fixture = await proof(),
    controller = new AbortController()
  let calls = 0,
    waits = 0
  const insufficient = await acceptSignallingProof({
    request: fixture.request,
    clock: { monotonic: () => 10 },
    timers: {
      after() {
        waits++
        return () => {}
      },
    },
    deadline: 1010,
    signal: controller.signal,
    credentials: {
      async accept() {
        calls++
        return { ok: false, reason: 'busy', retryAfterMs: 1000 }
      },
    },
  })
  assert.deepEqual(insufficient, { ok: false, reason: 'denied' })
  assert.equal(calls, 1)
  assert.equal(waits, 0)
  let mono = 0
  const capped = await acceptSignallingProof({
    request: fixture.request,
    clock: { monotonic: () => mono },
    timers: {
      after(ms, callback) {
        mono += ms
        queueMicrotask(callback)
        return () => {}
      },
    },
    deadline: 8000,
    signal: controller.signal,
    credentials: {
      async accept() {
        calls++
        return { ok: false, reason: 'busy', retryAfterMs: 1000 }
      },
    },
  })
  assert.deepEqual(capped, { ok: false, reason: 'denied' })
  assert.equal(calls, 4)
  assert.equal(mono, 2000)
})
test('abort while waiting cancels its timer and never attempts completion again', async () => {
  const fixture = await proof(),
    controller = new AbortController()
  const active = new Set<ReturnType<typeof setTimeout>>()
  let started = () => {},
    calls = 0
  const waiting = new Promise<void>((resolve) => {
    started = resolve
  })
  const result = acceptSignallingProof({
    request: fixture.request,
    clock: { monotonic: () => performance.now() },
    timers: {
      after(ms, callback) {
        const timer = setTimeout(callback, ms)
        active.add(timer)
        started()
        return () => {
          clearTimeout(timer)
          active.delete(timer)
        }
      },
    },
    deadline: performance.now() + 8000,
    signal: controller.signal,
    credentials: {
      async accept() {
        calls++
        return { ok: false, reason: 'busy', retryAfterMs: 1000 }
      },
    },
  })
  await waiting
  controller.abort()
  assert.deepEqual(await result, { ok: false, reason: 'denied' })
  assert.equal(active.size, 0)
  assert.equal(calls, 1)
})
test('storage uncertainty and an accepted result arriving after deadline fail closed without retry', async () => {
  const fixture = await proof(),
    controller = new AbortController()
  for (const throws of [false, true]) {
    let calls = 0
    const result = await acceptSignallingProof({
      request: fixture.request,
      clock: { monotonic: () => 0 },
      timers: {
        after() {
          assert.fail('Storage uncertainty must not retry')
        },
      },
      deadline: 8000,
      signal: controller.signal,
      credentials: {
        async accept(): Promise<CredentialAcceptanceDecision> {
          calls++
          if (throws) throw new Error('synthetic commit uncertainty')
          return { ok: false, reason: 'storage-unavailable' }
        },
      },
    })
    assert.deepEqual(result, { ok: false, reason: 'storage-unavailable' })
    assert.equal(calls, 1)
  }
  let mono = 0
  assert.deepEqual(
    await acceptSignallingProof({
      request: fixture.request,
      clock: { monotonic: () => mono },
      timers: nativeTimers,
      deadline: 8000,
      signal: controller.signal,
      credentials: {
        async accept() {
          mono = 8000
          return fixture.accepted
        },
      },
    }),
    { ok: false, reason: 'denied' },
  )
})
