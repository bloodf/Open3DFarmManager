import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  verify,
} from 'node:crypto'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import {
  ConnectorIdentity,
  loadOrCreateIdentity,
} from '../../packages/connector/src/identity/store.ts'
import { readAgentRuntimeConfig } from '../../packages/connector/src/config/runtime.ts'
import { credentialLookupId } from '../../packages/connector/src/config/signalling.ts'
import { openScopedTelemetryQueue } from '../../packages/connector/src/runtime/queue-scope.ts'
import { parseMoonrakerSnapshot } from '../../packages/connector/src/moonraker/parse.ts'
import { runConnectorAgent } from '../../packages/connector/src/runtime/agent.ts'
import { readRuntimeCredential } from '../../packages/connector/src/config/credential.ts'
import {
  CredentialRepairRequired,
  readOrRecoverRuntimeCredential,
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

const readCredentialEnvelope = (path: string) =>
  JSON.parse(readFileSync(path, 'utf8')) as {
    approval: Record<string, unknown>
  }
const readOrRecoverEnvelope = (path: string) =>
  readCredentialEnvelope(path).approval.device_token
const b64 = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString('base64url')
function token(claims: Record<string, unknown>) {
  return `${b64({ alg: 'EdDSA', typ: 'JWT', kid: 'k' })}.${b64(claims)}.${randomBytes(64).toString('base64url')}`
}

/** In-memory server double that enforces the same signed challenge contract. */
function fixture(
  start = 1_000_000_000_000,
  options: { identity?: ConnectorIdentity; rootRemainingMs?: number } = {},
) {
  const clock = { now: start }
  const identity =
    options.identity ??
    new ConnectorIdentity(generateKeyPairSync('ed25519').privateKey)
  const publicKey = createPublicKey({
    key: Buffer.from(identity.publicKeySpki, 'base64url'),
    format: 'der',
    type: 'spki',
  })
  const agentId = randomUUID(),
    farmId = randomUUID(),
    rootJti = randomUUID()
  const server = {
    audience: 'open3dfarmmanager:connector',
    issued: 0,
    reject: 0 as number,
    unavailable: 0 as number,
    tamper: false,
    lastIdentity: undefined as RenewalIdentity | undefined,
    modes: [] as string[],
  }
  const claims = (jti: string, exp: number) => ({
    sub: agentId,
    farm_id: farmId,
    fingerprint: identity.fingerprint,
    iss: ORIGIN,
    aud: server.audience,
    jti,
    iat: exp - TTL,
    exp,
  })
  // Root issued 100 s before the fixture clock, like a credential in service.
  const rootExp = Math.floor(
    (start + (options.rootRemainingMs ?? (TTL - 100) * 1000)) / 1000,
  )
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
      server.modes.push(request.mode)
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
          // Readback returns the stored reservation, not a fresh one.
          issuedAt: committed.has(id.jti)
            ? committed.get(id.jti)!.expiresAt / 1000 - TTL
            : issuedAt,
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
  f.server.audience = 'open3dfarmmanager:other'
  await assert.rejects(f.once(), /claims do not match/)
  f.server.audience = 'open3dfarmmanager:connector'
  f.server.tamper = true
  await assert.rejects(f.once(), /does not match the reservation/)
  // The scheduler reports a mismatch distinctly from a generic failure.
  const reasons: string[] = []
  await runCredentialRenewal({
    credentialPath: f.credentialPath,
    credential: f.read(),
    identity: f.identity,
    transport: f.transport,
    origin: ORIGIN,
    audience: AUDIENCE,
    retryMinMs: 100_000,
    retryMaxMs: 100_000,
    signal: new AbortController().signal,
    onRenewed: () => assert.fail('mismatched successor must not be used'),
    onDiagnostic: (d) => {
      if (d.kind === 'credential-renewal-retry') reasons.push(d.reason)
    },
    now: () => f.clock.now,
    random: () => 0,
    sleep: async (ms) => {
      f.clock.now += ms
    },
  })
  assert.ok(reasons.length > 0)
  assert.ok(reasons.every((r) => r === 'successor-mismatch'))
  // An invalid envelope is rejected in memory, before any temp file or rename.
  assert.throws(() =>
    writeCredentialFileAtomically(f.credentialPath, {
      ...readCredentialEnvelope(f.credentialPath),
      expected_fingerprint: 'not-a-fingerprint',
    } as never),
  )
  assert.deepEqual(readCredentialEnvelope(f.credentialPath).approval, {
    status: 'approved',
    agent_id: before.agent_id,
    farm_id: before.farm_id,
    device_token: before.device_token,
    expires_at: before.expires_at,
  })
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

test('agent restarts after renewal and its telemetry sender uses the successor', async (t) => {
  const data = mkdtempSync(join(tmpdir(), 'o3dfm-renewal-agent-'))
  chmodSync(data, 0o700)
  const identity = loadOrCreateIdentity(data)
  // Real clock: root expires in ~4 s, so renewal runs within ~2-3 s.
  const f = fixture(Date.now(), { identity, rootRemainingMs: 4000 })
  Object.defineProperty(f.clock, 'now', { get: Date.now, set() {} })
  const originalFetch = globalThis.fetch
  const closed = createServer()
  await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
  const moonPort = (closed.address() as { port: number }).port
  await new Promise<void>((resolve) => closed.close(() => resolve()))
  t.after(() => {
    globalThis.fetch = originalFetch
    f.cleanup()
    rmSync(data, { recursive: true, force: true })
  })
  const root = f.read()
  const moon = `http://127.0.0.1:${moonPort}`
  const configPath = join(data, 'runtime.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      collection: {
        version: 1,
        allowedOrigins: [moon],
        printers: [{ printerKey: 'sim-1', origin: moon }],
      },
      assignments: [
        {
          assignment_id: randomUUID(),
          agent_id: root.agent_id,
          farm_id: root.farm_id,
          printer_key: 'sim-1',
          moonraker_origin: moon,
        },
      ],
      telemetry: {
        endpoint: ORIGIN + '/api/connector/telemetry',
        audience: 'open3dfarmmanager:connector',
        retryMinMs: 100,
        retryMaxMs: 100,
        idleMs: 100,
      },
      renewal: { audience: AUDIENCE, retryMinMs: 100, retryMaxMs: 200 },
    }),
    { mode: 0o600 },
  )
  // Seed one record so the drain loop actually calls the telemetry sender.
  const queue = openScopedTelemetryQueue({
    dataDirectory: data,
    config: readAgentRuntimeConfig(configPath, root),
    credential: root,
    now: Date.now(),
  })
  const { printer } = parseMoonrakerSnapshot(
    readFileSync(
      new URL('../fixtures/moonraker/printing.json', import.meta.url),
      'utf8',
    ),
    { printerKey: 'sim-1', observedAt: Date.now() },
  )
  queue.enqueue(printer, Date.now())
  queue.close()
  const telemetryJtis: string[] = []
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const target = String(url)
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    if (target.startsWith(ORIGIN + '/api/connector/credentials/renewal/')) {
      const step = target.slice(target.lastIndexOf('/') + 1) as
        'challenge' | 'complete'
      const answer = await f.transport(
        step,
        JSON.parse(String(init?.body)),
        new AbortController().signal,
      )
      return json(answer.status, answer.body)
    }
    if (target === ORIGIN + '/api/connector/telemetry/challenge') {
      const auth = new Headers(init?.headers).get('authorization') ?? ''
      telemetryJtis.push(credentialLookupId(auth.replace(/^Bearer /, '')))
      return json(503, { error: 'synthetic' })
    }
    throw new Error('Unexpected fetch ' + target)
  }) as typeof fetch
  const rootJti = credentialLookupId(root.device_token)
  const controller = new AbortController()
  const kinds: string[] = []
  const running = runConnectorAgent({
    configPath,
    credentialPath: f.credentialPath,
    dataDirectory: data,
    signal: controller.signal,
    onDiagnostic: (d) => kinds.push(d.kind),
  })
  const deadline = Date.now() + 15000
  while (!telemetryJtis.some((jti) => jti !== rootJti) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50))
  controller.abort()
  await running
  const successor = f.read()
  const successorJti = credentialLookupId(successor.device_token)
  assert.notEqual(successorJti, rootJti)
  assert.equal(successor.root_jti, rootJti)
  assert.equal(telemetryJtis[0], rootJti)
  assert.equal(telemetryJtis.at(-1), successorJti)
  // After the switch, the root token is never presented again.
  const first = telemetryJtis.indexOf(successorJti)
  assert.ok(telemetryJtis.slice(first).every((jti) => jti === successorJti))
  assert.ok(kinds.includes('credential-renewed'))
  // One summary per agent run: the original and the restarted one.
  assert.equal(kinds.filter((k) => k === 'agent-summary').length, 2)
})

test('startup recovers an expired credential by readback only, never by issue', async (t) => {
  const f = fixture()
  t.after(f.cleanup)
  const root = f.read()
  // Server committed a successor whose reply was lost: simulate with a failed local write.
  chmodSync(f.directory, 0o500)
  await assert.rejects(f.once())
  chmodSync(f.directory, 0o700)
  assert.deepEqual(f.read(), root)
  f.clock.now = root.expires_at + 1000
  f.server.modes.length = 0
  const kinds: string[] = []
  const recovered = await readOrRecoverRuntimeCredential({
    credentialPath: f.credentialPath,
    identity: f.identity,
    now: () => f.clock.now,
    onDiagnostic: (d) => kinds.push(d.kind),
    recovery: {
      transport: f.transport,
      origin: ORIGIN,
      audience: AUDIENCE,
      signal: new AbortController().signal,
    },
  })
  assert.deepEqual(f.server.modes, ['readback'])
  assert.equal(f.server.issued, 1)
  assert.ok(recovered.expires_at > f.clock.now)
  assert.equal(recovered.root_jti, f.rootJti)
  assert.deepEqual(f.read(), recovered)
  assert.deepEqual(kinds, ['credential-recovered'])
})

test('startup fails closed when an expired credential has no committed successor', async (t) => {
  const f = fixture()
  t.after(f.cleanup)
  const root = f.read()
  const kinds: string[] = []
  const recover = (
    recovery?: Parameters<typeof readOrRecoverRuntimeCredential>[0]['recovery'],
  ) =>
    readOrRecoverRuntimeCredential({
      credentialPath: f.credentialPath,
      identity: f.identity,
      now: () => f.clock.now,
      onDiagnostic: (d) => kinds.push(d.kind),
      ...(recovery ? { recovery } : {}),
    })
  // A current credential is returned without any network call.
  assert.deepEqual(await recover(), root)
  assert.deepEqual(f.server.modes, [])
  f.clock.now = root.expires_at
  const recovery = {
    transport: f.transport,
    origin: ORIGIN,
    audience: AUDIENCE,
    signal: new AbortController().signal,
    sleep: async () => {},
  }
  // Denied readback: one attempt, then re-pair.
  await assert.rejects(recover(recovery), CredentialRepairRequired)
  assert.deepEqual(f.server.modes, ['readback'])
  // Transient unavailability: bounded attempts, then re-pair.
  f.server.modes.length = 0
  f.server.unavailable = 10
  await assert.rejects(recover(recovery), CredentialRepairRequired)
  assert.equal(f.server.unavailable, 7)
  // No renewal configuration: no network at all.
  await assert.rejects(recover(), CredentialRepairRequired)
  assert.deepEqual(kinds, [
    'credential-repair-required',
    'credential-repair-required',
    'credential-repair-required',
  ])
  assert.deepEqual(readOrRecoverEnvelope(f.credentialPath), root.device_token)
  assert.deepEqual(readdirSync(f.directory), ['credential.json'])
})
