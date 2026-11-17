import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import {
  CredentialProofCompletion,
  CredentialProofRequest,
  credentialProofPayload,
  type CredentialProofChallenge,
} from '../../packages/farm-protocol/src/credential-proof.ts'
import {
  MAX_TRUSTED_BROWSER_KEYS,
  MAX_TRUSTED_ISSUER_KEYS,
  MAX_TRUSTED_KEY_SET_WIRE_BYTES,
  TRUSTED_KEY_CONFIRMATION_INTERVAL_MS,
  decodeTrustedKeySetFrame,
  encodeTrustedKeySetFrame,
  signTrustedKeySet,
  verifyTrustedKeySet,
  type TrustedBrowserKey,
  type TrustedIssuerKey,
} from '../../packages/farm-protocol/src/trusted-keys.ts'
import { connectorKeyBinding } from '../../apps/farm/server/utils/connector-credentials.ts'
import type { CredentialAcceptanceDecision } from '../../apps/farm/server/storage/postgres-connector-credential-acceptance.ts'
import {
  ConfigurationSignallingCoordinator,
  type ConfigurationSignallingEndpoint,
} from '../../apps/farm/server/services/configuration-signalling-coordinator.ts'
import {
  createTrustedKeyPublisher,
  type TrustedKeyRow,
  type TrustedKeySource,
} from '../../apps/farm/server/utils/trusted-keys/publisher.ts'

const NOW = 1_800_000_000_000
const origin = 'https://farm.example.invalid'
const credentialAudience = 'open3dfarm:connector'
const issuerName = 'open3dfarm:trusted-key-issuer'
const FARM_A = '22222222-2222-4222-8222-222222222222'
const FARM_B = '99999999-9999-4999-8999-999999999999'
const token = 'synthetic-connector-credential'

const spkiOf = async (key: CryptoKey) =>
  Buffer.from(await crypto.subtle.exportKey('spki', key)).toString('base64url')
async function issuerFixture(kid = 'issuer-1') {
  const pair = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const entry: TrustedIssuerKey = {
    issuer: issuerName,
    kid,
    public_key_spki: await spkiOf(pair.publicKey),
  }
  return { pair, entry }
}
async function browserKey(): Promise<TrustedBrowserKey> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )
  const { kty, crv, x, y } = await crypto.subtle.exportKey(
    'jwk',
    pair.publicKey,
  )
  const key = await validateBrowserDevicePublicKey({ kty, crv, x, y })
  return {
    key_id: randomUUID(),
    account_id: `account_${randomBytes(6).toString('hex')}`,
    thumbprint: key.thumbprint,
    public_key: key.publicKey,
  }
}
const sortKeys = <T extends { key_id: string }>(keys: T[]) =>
  [...keys].sort((a, b) => (a.key_id < b.key_id ? -1 : 1))
const unsigned = (
  issuer: TrustedIssuerKey,
  browser: TrustedBrowserKey[],
  extra: Record<string, unknown> = {},
) => ({
  v: 1,
  purpose: 'trusted-key-set',
  farm_id: FARM_A,
  version: 1,
  issued_at: NOW,
  issuer: issuer.issuer,
  kid: issuer.kid,
  issuer_keys: [issuer],
  browser_keys: sortKeys(browser),
  ...extra,
})

test('frame schema signs, verifies and round-trips canonically', async () => {
  const { pair, entry } = await issuerFixture()
  const signed = await signTrustedKeySet(
    unsigned(entry, [await browserKey(), await browserKey()]),
    pair.privateKey,
  )
  assert.equal(await verifyTrustedKeySet(signed, pair.publicKey), true)
  const wire = encodeTrustedKeySetFrame({
    v: 1,
    t: 'trusted-keys.set',
    key_set: signed,
  })
  assert.deepEqual(decodeTrustedKeySetFrame(wire).key_set, signed)
  assert.throws(() => decodeTrustedKeySetFrame(` ${wire}`))
  assert.throws(() =>
    decodeTrustedKeySetFrame(wire.replace('"v":1,', '"v":1,"x":1,')),
  )
})

test('signature binds content, farm and signer key', async () => {
  const { pair, entry } = await issuerFixture()
  const other = await issuerFixture()
  const signed = await signTrustedKeySet(
    unsigned(entry, [await browserKey()]),
    pair.privateKey,
  )
  assert.equal(await verifyTrustedKeySet(signed, other.pair.publicKey), false)
  assert.equal(
    await verifyTrustedKeySet({ ...signed, farm_id: FARM_B }, pair.publicKey),
    false,
  )
  assert.equal(
    await verifyTrustedKeySet({ ...signed, version: 2 }, pair.publicKey),
    false,
  )
  assert.equal(
    await verifyTrustedKeySet({ ...signed, browser_keys: [] }, pair.publicKey),
    false,
  )
  await assert.rejects(
    signTrustedKeySet(unsigned(entry, []), pair.publicKey),
    /Ed25519 issuer key/,
  )
  const extractable = await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])
  await assert.rejects(
    signTrustedKeySet(unsigned(entry, []), extractable.privateKey),
    /nonextractable/,
  )
})

test('schema enforces size bounds, ordering and consistency', async () => {
  const { pair, entry } = await issuerFixture()
  // The cap itself fits inside the wire bound.
  const full = await Promise.all(
    Array.from({ length: MAX_TRUSTED_BROWSER_KEYS }, browserKey),
  )
  const signedFull = await signTrustedKeySet(
    unsigned(entry, full),
    pair.privateKey,
  )
  const wire = encodeTrustedKeySetFrame({
    v: 1,
    t: 'trusted-keys.set',
    key_set: signedFull,
  })
  assert.ok(Buffer.byteLength(wire) <= MAX_TRUSTED_KEY_SET_WIRE_BYTES)
  // One more browser key, too many issuer keys, bad order, duplicate, unlisted signer.
  await assert.rejects(
    signTrustedKeySet(
      unsigned(entry, [...full, await browserKey()]),
      pair.privateKey,
    ),
  )
  const issuers = await Promise.all(
    Array.from({ length: MAX_TRUSTED_ISSUER_KEYS + 1 }, (_, i) =>
      issuerFixture(`issuer-${String(i).padStart(2, '0')}`),
    ),
  )
  await assert.rejects(
    signTrustedKeySet(
      unsigned(entry, [], { issuer_keys: issuers.map((i) => i.entry) }),
      pair.privateKey,
    ),
  )
  const two = sortKeys([await browserKey(), await browserKey()]) as [
    TrustedBrowserKey,
    TrustedBrowserKey,
  ]
  await assert.rejects(
    signTrustedKeySet(
      unsigned(entry, [], { browser_keys: [two[1], two[0]] }),
      pair.privateKey,
    ),
  )
  await assert.rejects(
    signTrustedKeySet(
      unsigned(entry, [], { browser_keys: [two[0], two[0]] }),
      pair.privateKey,
    ),
  )
  await assert.rejects(
    signTrustedKeySet(
      unsigned(entry, [], { kid: 'unlisted' }),
      pair.privateKey,
    ),
  )
  // Thumbprint must match the key it names.
  const forged = { ...two[0], thumbprint: two[1].thumbprint }
  await assert.rejects(
    signTrustedKeySet(unsigned(entry, [forged]), pair.privateKey),
    /thumbprint/,
  )
  // Private key parameters are never accepted.
  await assert.rejects(
    signTrustedKeySet(
      unsigned(entry, [
        { ...two[0], public_key: { ...two[0].public_key, d: 'x' } },
      ] as unknown as TrustedBrowserKey[]),
      pair.privateKey,
    ),
  )
  assert.throws(() => decodeTrustedKeySetFrame('x'.repeat(40000)))
})

/** Real inbox coordinator, synthetic credential acceptance, one Connector per farm. */
async function inboxFixture() {
  let wall = NOW
  const clock = { wall: () => wall, monotonic: () => wall - NOW + 1000 }
  const connector = await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])
  const spki = await spkiOf(connector.publicKey)
  const { connectorFingerprintFromSpki } =
    await import('../../packages/farm-protocol/src/configuration-binding.ts')
  const fingerprint = await connectorFingerprintFromSpki(spki)
  const thumbprint = (await connectorKeyBinding(spki)).thumbprint
  const jti = randomUUID()
  const credentials = {
    async issue(input: unknown): Promise<CredentialAcceptanceDecision> {
      const request = CredentialProofRequest.parse(input)
      const challenge: CredentialProofChallenge = {
        v: 1,
        agent_id: request.agentId,
        farm_id: request.farmId,
        jti,
        connection_id: request.connectionId,
        public_key_spki: spki,
        fingerprint,
        thumbprint,
        token_hash: createHash('sha256').update(token).digest('base64url'),
        origin,
        audience: credentialAudience,
        purpose: 'signalling',
        generation: 1,
        nonce: randomBytes(32).toString('base64url'),
        issued_at: wall,
        expires_at: wall + 30_000,
      }
      return { ok: true, kind: 'challenge', challenge }
    },
    async accept(input: unknown): Promise<CredentialAcceptanceDecision> {
      const done = CredentialProofCompletion.parse(input)
      const valid = await crypto.subtle.verify(
        { name: 'Ed25519' },
        connector.publicKey,
        Buffer.from(done.signature, 'base64url'),
        new Uint8Array(credentialProofPayload(done.challenge)),
      )
      if (!valid) return { ok: false, reason: 'denied' }
      return {
        ok: true,
        kind: 'accepted',
        agentId: done.agentId,
        farmId: done.farmId,
        jti,
        connectionId: done.connectionId,
        purpose: 'signalling',
        acceptedAt: wall,
        expiresAt: wall + 600_000,
      }
    },
  }
  const coordinator = new ConfigurationSignallingCoordinator({
    authority: { read: async () => null },
    credentials,
    credentialAudience,
    clock,
    timers: { after: () => () => {} },
  })
  function endpoint() {
    const sent: string[] = []
    const port: ConfigurationSignallingEndpoint = {
      purpose: 'configuration',
      armDeadline: () => () => {},
      send: (wire) => void sent.push(wire),
      close: () => {},
    }
    return { sent, port }
  }
  async function connect(farmId: string, prove = true) {
    const ep = endpoint()
    const begun = await coordinator.connectorBegin(
      { farmId, agentId: randomUUID(), jti, token },
      ep.port,
    )
    assert.equal(begun?.kind, 'challenge')
    if (begun?.kind !== 'challenge') throw new Error('unreachable')
    if (prove) {
      const signature = Buffer.from(
        await crypto.subtle.sign(
          { name: 'Ed25519' },
          connector.privateKey,
          new Uint8Array(credentialProofPayload(begun.challenge)),
        ),
      ).toString('base64url')
      assert.ok(await coordinator.connectorProve(begun.handle, signature))
    }
    return ep
  }
  return {
    coordinator,
    connect,
    advance: (ms: number) => void (wall += ms),
  }
}

async function publisherFixture() {
  const inbox = await inboxFixture()
  const { pair, entry } = await issuerFixture()
  const state = {
    issuer: [entry] as TrustedIssuerKey[],
    rows: new Map<string, TrustedKeyRow[]>(),
    fail: false,
    leakForeign: false,
  }
  const reads: string[] = []
  const source: TrustedKeySource = {
    async read(farmId) {
      reads.push(farmId)
      if (state.fail) throw new Error('synthetic storage failure')
      const own = state.rows.get(farmId) ?? []
      const foreign = state.leakForeign
        ? [...(state.rows.get(farmId === FARM_A ? FARM_B : FARM_A) ?? [])]
        : []
      return { issuerKeys: state.issuer, browserKeys: [...own, ...foreign] }
    },
  }
  let tick = () => {}
  const errors: string[] = []
  let wall = NOW
  const publisher = createTrustedKeyPublisher({
    source,
    inboxes: inbox.coordinator,
    signer: { issuer: issuerName, kid: entry.kid, signingKey: pair.privateKey },
    clock: { wall: () => wall },
    timers: {
      every: (ms, callback) => {
        assert.equal(ms, TRUSTED_KEY_CONFIRMATION_INTERVAL_MS)
        tick = callback
        return () => {
          tick = () => {}
        }
      },
    },
    onError: (_farm, reason) => void errors.push(reason),
  })
  const row = async (farmId: string): Promise<TrustedKeyRow> => ({
    ...(await browserKey()),
    farmId,
  })
  const decode = (wire: string) => decodeTrustedKeySetFrame(wire).key_set
  return {
    ...inbox,
    pair,
    entry,
    state,
    reads,
    errors,
    publisher,
    row,
    decode,
    tick: () => tick(),
    setWall: (value: number) => void (wall = value),
  }
}

test('authenticated inbox gets the signed set on proof; unproved inbox gets nothing', async () => {
  const f = await publisherFixture()
  const approved = await f.row(FARM_A)
  f.state.rows.set(FARM_A, [approved])
  const pending = await f.connect(FARM_A, false)
  await f.publisher.notifyChange(FARM_A)
  assert.deepEqual(pending.sent, [], 'no proof, no frame')
  const live = await f.connect(FARM_A)
  await f.publisher.idle()
  assert.equal(live.sent.length, 1)
  const set = f.decode(live.sent[0]!)
  assert.equal(set.farm_id, FARM_A)
  assert.deepEqual(
    set.browser_keys.map((k) => k.key_id),
    [approved.key_id],
  )
  assert.deepEqual(set.issuer_keys, [f.entry])
  assert.equal(await verifyTrustedKeySet(set, f.pair.publicKey), true)
  f.publisher.close()
})

test('approval and revocation publish a strictly newer version within one confirmation interval', async () => {
  const f = await publisherFixture()
  const first = await f.row(FARM_A)
  f.state.rows.set(FARM_A, [first])
  const live = await f.connect(FARM_A)
  await f.publisher.idle()
  const v1 = f.decode(live.sent.at(-1)!)
  assert.equal(live.sent.length, 1)

  // Approval, picked up by the confirmation-interval re-read (no notification).
  const second = await f.row(FARM_A)
  f.state.rows.set(FARM_A, [first, second])
  f.setWall(NOW + 100)
  f.tick()
  await f.publisher.idle()
  assert.equal(live.sent.length, 2)
  const v2 = f.decode(live.sent.at(-1)!)
  assert.ok(v2.version > v1.version)
  assert.deepEqual(
    new Set(v2.browser_keys.map((k) => k.key_id)),
    new Set([first.key_id, second.key_id]),
  )

  // Revocation, announced directly: sent before notifyChange resolves.
  f.state.rows.set(FARM_A, [second])
  f.setWall(NOW + 200)
  await f.publisher.notifyChange(FARM_A)
  assert.equal(live.sent.length, 3)
  const v3 = f.decode(live.sent.at(-1)!)
  assert.ok(v3.version > v2.version)
  assert.deepEqual(
    v3.browser_keys.map((k) => k.key_id),
    [second.key_id],
  )
  for (const set of [v1, v2, v3])
    assert.equal(await verifyTrustedKeySet(set, f.pair.publicKey), true)

  // Rotation of the issuer key set is a change too.
  const next = await issuerFixture('issuer-2')
  f.state.issuer = [f.entry, next.entry]
  f.tick()
  await f.publisher.idle()
  const v4 = f.decode(live.sent.at(-1)!)
  assert.ok(v4.version > v3.version)
  assert.deepEqual(
    v4.issuer_keys.map((k) => k.kid),
    ['issuer-1', 'issuer-2'],
  )

  // No change, no new version (even with the same wall clock).
  const count = live.sent.length
  f.tick()
  await f.publisher.idle()
  assert.equal(live.sent.length, count)
  assert.ok(TRUSTED_KEY_CONFIRMATION_INTERVAL_MS <= 5000)
  f.publisher.close()
})

test('version stays strictly increasing when the wall clock does not advance', async () => {
  const f = await publisherFixture()
  f.state.rows.set(FARM_A, [await f.row(FARM_A)])
  const live = await f.connect(FARM_A)
  await f.publisher.idle()
  f.state.rows.set(FARM_A, [])
  await f.publisher.notifyChange(FARM_A)
  const [a, b] = live.sent.map(f.decode)
  assert.ok(a && b && b.version > a.version)
  f.publisher.close()
})

test('keys of other farms never appear, even if the source leaks them', async () => {
  const f = await publisherFixture()
  const a = await f.row(FARM_A)
  const b = await f.row(FARM_B)
  f.state.rows.set(FARM_A, [a])
  f.state.rows.set(FARM_B, [b])
  const inboxA = await f.connect(FARM_A)
  const inboxB = await f.connect(FARM_B)
  await f.publisher.idle()
  const setA = f.decode(inboxA.sent.at(-1)!)
  const setB = f.decode(inboxB.sent.at(-1)!)
  assert.equal(setA.farm_id, FARM_A)
  assert.equal(setB.farm_id, FARM_B)
  assert.deepEqual(
    setA.browser_keys.map((k) => k.key_id),
    [a.key_id],
  )
  assert.deepEqual(
    setB.browser_keys.map((k) => k.key_id),
    [b.key_id],
  )
  assert.ok(!inboxA.sent.join('').includes(b.key_id))
  assert.ok(!inboxA.sent.join('').includes(b.thumbprint))
  assert.ok(!inboxB.sent.join('').includes(a.key_id))

  // A farm-A change reaches only farm A's inbox.
  const before = inboxB.sent.length
  f.state.rows.set(FARM_A, [])
  await f.publisher.notifyChange(FARM_A)
  assert.equal(inboxB.sent.length, before)

  // A faulty source returning foreign rows fails closed: nothing is sent.
  f.state.leakForeign = true
  f.state.rows.set(FARM_A, [a])
  const countA = inboxA.sent.length
  await f.publisher.notifyChange(FARM_A)
  assert.equal(inboxA.sent.length, countA)
  assert.ok(f.errors.includes('invalid'))
  f.publisher.close()
})

test('source failure keeps the last set, never publishes partial data, then recovers', async () => {
  const f = await publisherFixture()
  const a = await f.row(FARM_A)
  f.state.rows.set(FARM_A, [a])
  const live = await f.connect(FARM_A)
  await f.publisher.idle()
  assert.equal(live.sent.length, 1)
  f.state.fail = true
  f.state.rows.set(FARM_A, [])
  await f.publisher.notifyChange(FARM_A)
  f.tick()
  await f.publisher.idle()
  assert.equal(live.sent.length, 1)
  assert.ok(f.errors.includes('source'))
  f.state.fail = false
  f.setWall(NOW + 50)
  f.tick()
  await f.publisher.idle()
  assert.equal(live.sent.length, 2)
  assert.deepEqual(f.decode(live.sent[1]!).browser_keys, [])
  f.publisher.close()
})

test('oversize farm and unlisted signer fail closed', async () => {
  const f = await publisherFixture()
  f.state.rows.set(
    FARM_A,
    await Promise.all(
      Array.from({ length: MAX_TRUSTED_BROWSER_KEYS + 1 }, () => f.row(FARM_A)),
    ),
  )
  const live = await f.connect(FARM_A)
  await f.publisher.idle()
  assert.deepEqual(live.sent, [])
  f.state.rows.set(FARM_A, [])
  f.state.issuer = [(await issuerFixture('someone-else')).entry]
  await f.publisher.notifyChange(FARM_A)
  assert.deepEqual(live.sent, [])
  assert.ok(f.errors.every((reason) => reason === 'invalid'))
  f.publisher.close()
})

test('closed publisher stops listening and sending', async () => {
  const f = await publisherFixture()
  f.state.rows.set(FARM_A, [await f.row(FARM_A)])
  f.publisher.close()
  f.publisher.close()
  const reads = f.reads.length
  const live = await f.connect(FARM_A)
  await f.publisher.idle()
  await f.publisher.notifyChange(FARM_A)
  f.tick()
  await f.publisher.idle()
  assert.deepEqual(live.sent, [])
  assert.equal(f.reads.length, reads)
})
