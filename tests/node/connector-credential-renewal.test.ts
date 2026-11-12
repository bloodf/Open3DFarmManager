import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  verify,
} from 'node:crypto'
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import { readRuntimeCredential } from '../../packages/connector/src/config/credential.ts'
import {
  renewCredentialOnce,
  runCredentialRenewal,
  writeCredentialFileAtomically,
  type RenewalTransport,
} from '../../packages/connector/src/cloud/credential-renewal.ts'
import {
  RenewalChallenge,
  RenewalCompletion,
  RenewalRequest,
  renewalIntentPayload,
  renewalProofPayload,
  type RenewalIdentity,
} from '../../packages/farm-protocol/src/credential-renewal.ts'

const ORIGIN = 'https://farm.example'
const AUDIENCE = 'open3dfarmmanager:renewal'
const TTL = 300

const b64 = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString('base64url')
function token(claims: Record<string, unknown>) {
  return `${b64({ alg: 'EdDSA', typ: 'JWT', kid: 'k' })}.${b64(claims)}.${randomBytes(64).toString('base64url')}`
}

/** In-memory server double that enforces the same signed challenge contract. */
function fixture(start = 1_000_000_000_000) {
  const clock = { now: start }
  const identity = new ConnectorIdentity(
    generateKeyPairSync('ed25519').privateKey,
  )
  const publicKey = createPublicKey({
    key: Buffer.from(identity.publicKeySpki, 'base64url'),
    format: 'der',
    type: 'spki',
  })
  const agentId = randomUUID(),
    farmId = randomUUID(),
    rootJti = randomUUID()
  const claims = (jti: string, exp: number) => ({
    sub: agentId,
    farm_id: farmId,
    fingerprint: identity.fingerprint,
    jti,
    iat: exp - TTL,
    exp,
  })
  const rootExp = Math.floor(start / 1000) + TTL
  const directory = mkdtempSync(join(tmpdir(), 'o3dfm-renewal-'))
  chmodSync(directory, 0o700)
  const credentialPath = join(directory, 'credential.json')
  writeCredentialFileAtomically(credentialPath, {
    version: 1,
    expected_fingerprint: identity.fingerprint,
    approval: {
      status: 'approved',
      agent_id: agentId,
      farm_id: farmId,
      device_token: token(claims(rootJti, rootExp)),
      expires_at: rootExp * 1000,
    },
  })
  // Committed successors keyed by predecessor jti.
  const committed = new Map<
    string,
    { childJti: string; token: string; expiresAt: number }
  >()
  const server = {
    issued: 0,
    reject: 0 as number,
    unavailable: 0 as number,
    tamper: false,
    lastIdentity: undefined as RenewalIdentity | undefined,
  }
  const challenges = new Map<string, RenewalChallenge>()
  const transport: RenewalTransport = async (step, body) => {
    if (server.unavailable > 0) {
      server.unavailable--
      return { status: 503, body: { error: 'x' } }
    }
    if (step === 'challenge') {
      if (server.reject > 0) {
        server.reject--
        return { status: 403, body: { error: 'x' } }
      }
      const request = RenewalRequest.parse(body)
      const id =
        request.mode === 'issue' ? request.identity : request.intent.identity
      if (request.mode === 'issue') {
        if (committed.has(id.jti))
          return { status: 503, body: { reason: 'readback-required' } }
      } else {
        assert.equal(
          verify(
            null,
            renewalIntentPayload(request.intent),
            publicKey,
            Buffer.from(request.identitySignature, 'base64url'),
          ),
          true,
        )
        if (!committed.has(id.jti)) return { status: 403, body: {} }
      }
      const issuedAt = Math.floor(clock.now / 1000)
      const challenge = RenewalChallenge.parse({
        v: 1,
        mode: request.mode,
        identity: id,
        farmId,
        origin: ORIGIN,
        audience: AUDIENCE,
        publicKeySpki: identity.publicKeySpki,
        fingerprint: identity.fingerprint,
        thumbprint: randomBytes(32).toString('base64url'),
        reservation: {
          childJti: committed.get(id.jti)?.childJti ?? randomUUID(),
          ordinal: 1,
          kid: 'k',
          issuer: ORIGIN,
          audience: 'open3dfarmmanager:connector',
          issuedAt,
          expiresAt: committed.has(id.jti)
            ? committed.get(id.jti)!.expiresAt / 1000
            : issuedAt + TTL,
          tokenHash: randomBytes(32).toString('base64url'),
          codec: 1,
        },
        nonce: randomBytes(32).toString('base64url'),
        attempt: 1,
        issuedAt: clock.now,
        expiresAt: clock.now + 30000,
      })
      challenges.set(id.jti, challenge)
      return { status: 200, body: { kind: 'challenge', challenge } }
    }
    const completion = RenewalCompletion.parse(body)
    const id = completion.challenge.identity
    assert.deepEqual(completion.challenge, challenges.get(id.jti))
    assert.equal(
      verify(
        null,
        renewalProofPayload(completion.challenge),
        publicKey,
        Buffer.from(completion.signature, 'base64url'),
      ),
      true,
    )
    server.lastIdentity = id
    const reservation = completion.challenge.reservation
    let result = committed.get(id.jti)
    if (completion.request.mode === 'issue') {
      assert.equal(result, undefined)
      server.issued++
      result = {
        childJti: reservation.childJti,
        token: token(claims(reservation.childJti, reservation.expiresAt)),
        expiresAt: reservation.expiresAt * 1000,
      }
      committed.set(id.jti, result)
    }
    if (!result) return { status: 403, body: {} }
    return {
      status: 200,
      body: {
        kind: 'credential',
        identity: id,
        childJti: server.tamper ? randomUUID() : result.childJti,
        token: result.token,
        expiresAt: result.expiresAt,
      },
    }
  }
  const read = () =>
    readRuntimeCredential(credentialPath, identity.fingerprint, clock.now)
  const once = (signal = new AbortController().signal) =>
    renewCredentialOnce({
      credentialPath,
      credential: read(),
      identity,
      transport,
      origin: ORIGIN,
      audience: AUDIENCE,
      signal,
      now: () => clock.now,
    })
  return {
    clock,
    identity,
    server,
    transport,
    read,
    once,
    rootJti,
    directory,
    credentialPath,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  }
}

test('renewal persists a confirmed successor atomically with private permissions', async (t) => {
  const f = fixture()
  t.after(f.cleanup)
  const before = f.read()
  const outcome = await f.once()
  assert.equal(outcome.kind, 'renewed')
  assert.equal(f.server.issued, 1)
  assert.equal(f.server.lastIdentity?.kind, 'root')
  const after = f.read()
  assert.notEqual(after.device_token, before.device_token)
  assert.equal(after.root_jti, f.rootJti)
  assert.equal(statSync(f.credentialPath).mode & 0o777, 0o600)
  assert.deepEqual(readdirSync(f.directory), ['credential.json'])
  // The next renewal presents the successor as a successor of the same root.
  f.clock.now += 10_000
  assert.equal((await f.once()).kind, 'renewed')
  const last: RenewalIdentity | undefined = f.server.lastIdentity
  assert.equal(last?.rootJti, f.rootJti)
  assert.equal(last?.kind, 'successor')
  assert.equal(f.read().root_jti, f.rootJti)
})

test('server rejection and mismatched successors leave the current credential untouched', async (t) => {
  const f = fixture()
  t.after(f.cleanup)
  const before = f.read()
  f.server.reject = 1
  assert.deepEqual(await f.once(), { kind: 'retry', reason: 'challenge-403' })
  f.server.unavailable = 1
  assert.deepEqual(await f.once(), { kind: 'retry', reason: 'challenge-503' })
  f.server.tamper = true
  await assert.rejects(f.once(), /does not match/)
  assert.deepEqual(f.read(), before)
  assert.deepEqual(readdirSync(f.directory), ['credential.json'])
})

test('a crash between server commit and local persistence recovers by readback', async (t) => {
  const f = fixture()
  t.after(() => {
    chmodSync(f.directory, 0o700)
    f.cleanup()
  })
  const before = f.read()
  // Read-only directory: the temp file cannot be created after the server committed.
  chmodSync(f.directory, 0o500)
  await assert.rejects(f.once())
  chmodSync(f.directory, 0o700)
  assert.deepEqual(f.read(), before)
  assert.equal(f.server.issued, 1)
  const outcome = await f.once()
  assert.equal(outcome.kind, 'renewed')
  // Readback returned the same committed successor; no second issuance.
  assert.equal(f.server.issued, 1)
  assert.notEqual(f.read().device_token, before.device_token)
  assert.deepEqual(readdirSync(f.directory), ['credential.json'])
})

test('scheduler renews with jitter, backs off within bounds and fails closed at expiry', async (t) => {
  const f = fixture()
  t.after(f.cleanup)
  const start = f.clock.now
  const expiresAt = f.read().expires_at
  const sleeps: number[] = []
  const almostOne = 1 - 1e-9 // Math.random() is in [0, 1)
  const diagnostics: { kind: string; delayMs?: number }[] = []
  const renewed: number[] = []
  f.server.unavailable = Number.MAX_SAFE_INTEGER
  await runCredentialRenewal({
    credentialPath: f.credentialPath,
    credential: f.read(),
    identity: f.identity,
    transport: f.transport,
    origin: ORIGIN,
    audience: AUDIENCE,
    retryMinMs: 1000,
    retryMaxMs: 8000,
    signal: new AbortController().signal,
    onRenewed: (c) => renewed.push(c.expires_at),
    onDiagnostic: (d) => diagnostics.push(d),
    now: () => f.clock.now,
    random: () => almostOne,
    sleep: async (ms) => {
      assert.ok(ms > 0)
      sleeps.push(ms)
      f.clock.now += ms
    },
  })
  assert.deepEqual(renewed, [])
  assert.equal(diagnostics.at(-1)?.kind, 'credential-renewal-expired')
  // First attempt at ~75% of the remaining lifetime (upper jitter bound).
  assert.equal(
    sleeps[0],
    Math.floor((expiresAt - start) * (0.5 + 0.25 * almostOne)),
  )
  const delays = diagnostics.flatMap((d) => (d.delayMs ? [d.delayMs] : []))
  assert.deepEqual(delays.slice(0, 5), [1000, 2000, 4000, 8000, 8000])
  assert.ok(delays.every((d) => d <= 8000))
  assert.ok(f.clock.now >= expiresAt)
  // Never slept past hard expiry.
  assert.equal(f.clock.now, expiresAt)

  // Fresh credential: a successful renewal is reported once, then the caller stops it.
  const g = fixture()
  t.after(g.cleanup)
  const controller = new AbortController()
  const seen: string[] = []
  await runCredentialRenewal({
    credentialPath: g.credentialPath,
    credential: g.read(),
    identity: g.identity,
    transport: g.transport,
    origin: ORIGIN,
    audience: AUDIENCE,
    retryMinMs: 1000,
    retryMaxMs: 8000,
    signal: controller.signal,
    onRenewed: (c) => {
      seen.push(c.device_token)
      controller.abort()
    },
    now: () => g.clock.now,
    random: () => 0,
    sleep: async (ms) => {
      g.clock.now += ms
    },
  })
  assert.equal(seen.length, 1)
  assert.equal(g.read().device_token, seen[0])
})

test('renewal proof signing refuses foreign or stale challenges', async (t) => {
  const f = fixture()
  t.after(f.cleanup)
  const response = await f.transport(
    'challenge',
    {
      mode: 'issue',
      identity: {
        kind: 'root',
        rootJti: f.rootJti,
        jti: f.rootJti,
        agentId: f.read().agent_id,
      },
      farmId: f.read().farm_id,
      token: f.read().device_token,
    },
    new AbortController().signal,
  )
  const challenge = (response.body as { challenge: RenewalChallenge }).challenge
  const base = {
    challenge,
    expectedMode: 'issue' as const,
    expectedIdentity: challenge.identity,
    expectedFarmId: challenge.farmId,
    expectedOrigin: ORIGIN,
    expectedAudience: AUDIENCE,
    now: challenge.issuedAt,
  }
  assert.match(f.identity.signRenewalProof(base), /^[A-Za-z0-9_-]{86}$/)
  for (const change of [
    { expectedOrigin: 'https://other.example' },
    { expectedAudience: 'other' },
    { expectedMode: 'readback' as const },
    { expectedFarmId: randomUUID() },
    { now: challenge.expiresAt },
  ])
    assert.throws(
      () => f.identity.signRenewalProof({ ...base, ...change }),
      /not current or trusted/,
    )
})
