import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import postgres from 'postgres'
import {
  pauseAuthorityRequest,
  readPauseAuthorityBody,
} from '../../apps/farm/server/services/pause-authority-http.ts'
import { createPauseAuthorityService } from '../../apps/farm/server/services/pause-authority.ts'
import {
  PostgresPauseAuthority,
  type PauseChallengeDecision,
  type PauseCapabilityDecision,
} from '../../apps/farm/server/storage/postgres-pause-authority.ts'
import { browserDeviceFixture } from '../helpers/browser-device-http-integration.ts'
import {
  ControlSessionBinding,
  encodeControlProof,
  signControlSessionProof,
  controlBindingHash,
} from '../../packages/farm-protocol/src/control-session-binding.ts'
import {
  PauseAdmissionChallenge,
  signPauseAdmissionProof,
  encodePauseAdmissionProof,
  signPauseCapability,
} from '../../packages/farm-protocol/src/pause-capability.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'

function streamedRequest(
  url: string,
  init: RequestInit & { duplex: 'half' },
): Request {
  return new Request(url, init)
}

async function fixture(t: test.TestContext) {
  const f = await browserDeviceFixture()
  const issuer = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const connector = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const browser = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const { kty, crv, x, y } = await crypto.subtle.exportKey(
    'jwk',
    browser.publicKey,
  )
  const key = await validateBrowserDevicePublicKey({ kty, crv, x, y })
  const spki = Buffer.from(
    await crypto.subtle.exportKey('spki', connector.publicKey),
  )
  const digest = () => randomBytes(32).toString('base64url')
  const now = Date.now()
  const binding = ControlSessionBinding.parse({
    v: 1,
    purpose: 'pause-rtc',
    transport_id: randomUUID(),
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    account_id: 'account',
    key_id: randomUUID(),
    assignment_id: randomUUID(),
    browser_public_key: key.publicKey,
    browser_thumbprint: key.thumbprint,
    connector_public_key_spki: spki.toString('base64url'),
    connector_fingerprint:
      'SHA256:' + createHash('sha256').update(spki).digest('base64url'),
    credential_jti: randomUUID(),
    origin: f.runtime.auth.origin,
    audience: 'test:pause',
    browser_nonce: digest(),
    connector_nonce: digest(),
    issued_at: now,
    expires_at: now + 30000,
    offer_sha256: digest(),
    answer_sha256: digest(),
    browser_dtls: Array(32).fill('AA').join(':'),
    connector_dtls: Array(32).fill('BB').join(':'),
  })
  const request = {
    browserProofWire: encodeControlProof({
      v: 1,
      role: 'browser',
      binding,
      signature: await signControlSessionProof(
        binding,
        'browser',
        browser.privateKey,
      ),
    }),
    connectorProofWire: encodeControlProof({
      v: 1,
      role: 'connector',
      binding,
      signature: await signControlSessionProof(
        binding,
        'connector',
        connector.privateKey,
      ),
    }),
    admissionNonce: digest(),
  }
  const challenge = PauseAdmissionChallenge.parse({
    v: 1,
    purpose: 'pause-admission',
    challenge_id: randomUUID(),
    farm_id: binding.farm_id,
    agent_id: binding.agent_id,
    key_id: binding.key_id,
    assignment_id: binding.assignment_id,
    transport_id: binding.transport_id,
    account_id: binding.account_id,
    browser_thumbprint: binding.browser_thumbprint,
    origin: binding.origin,
    audience: binding.audience,
    control_binding_sha256: await controlBindingHash(binding),
    admission_nonce: request.admissionNonce,
    issued_at: now,
    expires_at: now + 8000,
  })
  // Lazy unused SQL pool and storage-method doubles: genuine login/unsealing and service parsing, not a DB authority claim.
  const sql = postgres({
    host: '127.0.0.1',
    port: 1,
    database: 'unused',
    username: 'unused',
    max: 1,
  })
  t.after(() => sql.end({ timeout: 1 }))
  const inputs: unknown[] = []
  let challengeAction: (
    input: unknown,
  ) => Promise<PauseChallengeDecision> = async (input) => {
    inputs.push(input)
    return { ok: true, challenge }
  }
  let capabilityAction: (
    input: unknown,
  ) => Promise<PauseCapabilityDecision> = async () => ({
    ok: false,
    reason: 'denied',
  })
  t.mock.method(sql, 'begin', () => {
    throw new Error('Unexpected fixture SQL')
  })
  // Service snapshots bound methods in its constructor, so install the storage double first.
  t.mock.method(
    PostgresPauseAuthority.prototype,
    'issueChallenge',
    (input: unknown) => challengeAction(input),
  )
  t.mock.method(
    PostgresPauseAuthority.prototype,
    'issueCapability',
    (input: unknown) => capabilityAction(input),
  )
  const service = createPauseAuthorityService(sql, {
    origin: binding.origin,
    audience: binding.audience,
    issuer: 'test:issuer',
    kid: 'test-key',
    credentialIssuer: 'test:credential',
    credentialAudience: 'test:credential',
    idleTimeoutMs: 1800000,
    signingKey: issuer.privateKey,
    verificationKey: issuer.publicKey,
  })
  t.after(() => service.close())
  const runtime = { auth: f.runtime.auth, authority: service }
  const event = (
    body = JSON.stringify(request),
    headers: Record<string, string> = {},
    path = '/api/pause-authority/challenges',
    method = 'POST',
  ) =>
    f.event(
      method,
      path,
      {
        cookie: f.cookie,
        origin: binding.origin,
        'content-type': 'application/json',
        ...headers,
      },
      method === 'GET' ? undefined : body,
    )
  return {
    ...f,
    event,
    issuer,
    browser,
    binding,
    request,
    challenge,
    service,
    runtime,
    inputs,
    setChallenge(action: typeof challengeAction) {
      challengeAction = action
    },
    setCapability(action: typeof capabilityAction) {
      capabilityAction = action
    },
  }
}

test(
  'own sealed login precedes quota, and only its private reference reaches the issuer',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t)
    for (const cookie of ['', '__Host-open3dfarmmanager-session=invalid'])
      await assert.rejects(
        pauseAuthorityRequest(
          f.event(undefined, { cookie }),
          f.runtime,
          'challenges',
        ),
        { status: 401 },
      )
    assert.deepEqual(f.limits, [])
    const event = f.event()
    assert.deepEqual(
      await pauseAuthorityRequest(event, f.runtime, 'challenges'),
      { challenge: f.challenge },
    )
    assert.equal(event.res.headers.get('cache-control'), 'no-store')
    assert.deepEqual(f.inputs, [
      { sessionRecordId: 'session_one', request: f.request },
    ])
    assert.deepEqual(f.limits, ['pause-authority:v1:challenges:session_one'])
    await f.sessions.revokeAccountSessions('account')
    await assert.rejects(
      pauseAuthorityRequest(f.event(), f.runtime, 'challenges'),
      { status: 401 },
    )
    assert.equal(f.limits.length, 1)
  },
)

test(
  'strict envelope, same-origin, canonical inner proofs and metadata-only success',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t)
    for (const [event, status] of [
      [f.event(undefined, {}, undefined, 'GET'), 405],
      [f.event(undefined, { origin: 'https://other.invalid' }), 403],
      [f.event(undefined, {}, '/api/pause-authority/challenges?x=1'), 400],
      [f.event(undefined, { 'content-encoding': 'identity' }), 415],
      [f.event(undefined, { 'content-type': 'text/plain' }), 415],
      [f.event('{"a":1,"a":2}'), 400],
      [
        f.event(JSON.stringify({ ...f.request, sessionRecordId: 'other' })),
        400,
      ],
      [
        f.event(JSON.stringify({ ...f.request, command: { action: 'pause' } })),
        400,
      ],
      [
        f.event(
          JSON.stringify({
            ...f.request,
            browserProofWire: ' ' + f.request.browserProofWire,
          }),
        ),
        400,
      ],
      [
        f.event(
          JSON.stringify({
            ...f.request,
            connectorProofWire: f.request.browserProofWire,
          }),
        ),
        400,
      ],
    ] as const)
      await assert.rejects(
        pauseAuthorityRequest(event, f.runtime, 'challenges'),
        { status },
      )
    assert.equal(f.inputs.length, 0)
    const proof = await signPauseAdmissionProof(
      f.challenge,
      f.browser.privateKey,
    )
    const capability = await signPauseCapability(
      {
        v: 1,
        purpose: 'pause-authority',
        capability_id: randomUUID(),
        issuer: 'test:issuer',
        kid: 'test-key',
        audience: f.binding.audience,
        origin: f.binding.origin,
        issued_at: f.binding.issued_at,
        expires_at: f.binding.expires_at,
        account_id: f.binding.account_id,
        role: 'operator',
        farm_id: f.binding.farm_id,
        agent_id: f.binding.agent_id,
        key_id: f.binding.key_id,
        assignment_id: f.binding.assignment_id,
        transport_id: f.binding.transport_id,
        browser_public_key: f.binding.browser_public_key,
        browser_thumbprint: f.binding.browser_thumbprint,
        connector_fingerprint: f.binding.connector_fingerprint,
        credential_jti: f.binding.credential_jti,
        printer_key: 'synthetic-only',
        control_binding_sha256: f.challenge.control_binding_sha256,
        admission_nonce: f.request.admissionNonce,
        actions: ['pause'],
      },
      f.issuer.privateKey,
    )
    const admissionProofWire = encodePauseAdmissionProof(proof)
    f.setCapability(async (input: unknown) => {
      assert.deepEqual(input, {
        sessionRecordId: 'session_one',
        request: { admissionProofWire },
      })
      return { ok: true, capability }
    })
    assert.deepEqual(
      await pauseAuthorityRequest(
        f.event(JSON.stringify({ admissionProofWire })),
        f.runtime,
        'capabilities',
      ),
      { capability },
    )
    assert.equal(f.limits.at(-1), 'pause-authority:v1:capabilities:session_one')
  },
)

test(
  'escaped maximum decoded strings fit finite outer caps; malformed UTF-8, byte overflow and excessive chunks reject',
  { timeout: 10000 },
  async () => {
    const body = (value: BodyInit) =>
      streamedRequest('https://farm.invalid/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: value,
        duplex: 'half',
      })
    const escaped = '\\u0001'.repeat(8192)
    const wire = `{"browserProofWire":"${escaped}","connectorProofWire":"${escaped}","admissionNonce":"${'A'.repeat(43)}"}`
    const parsed = await readPauseAuthorityBody(body(wire), 'challenges')
    assert.deepEqual(parsed, {
      browserProofWire: '\u0001'.repeat(8192),
      connectorProofWire: '\u0001'.repeat(8192),
      admissionNonce: 'A'.repeat(43),
    })
    assert.deepEqual(
      await readPauseAuthorityBody(
        body(`{"admissionProofWire":"${escaped}"}`),
        'capabilities',
      ),
      { admissionProofWire: '\u0001'.repeat(8192) },
    )
    for (const [value, operation, status] of [
      [new Uint8Array([0xff]), 'challenges', 400],
      [' '.repeat(102401), 'challenges', 413],
      [' '.repeat(51201), 'capabilities', 413],
      [
        JSON.stringify({ admissionProofWire: 'é'.repeat(8193) }),
        'capabilities',
        400,
      ],
    ] as const)
      await assert.rejects(readPauseAuthorityBody(body(value), operation), {
        status,
      })
    let sent = 0
    const chunks = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (++sent <= 1025) controller.enqueue(new Uint8Array([32]))
        else controller.close()
      },
    })
    await assert.rejects(readPauseAuthorityBody(body(chunks), 'challenges'), {
      status: 413,
    })
  },
)

test(
  'body cancellation settlement and service close do not free pending operation capacity or rewrite issuance',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t)
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered = 0
    let reached: (() => void) | undefined
    const allEntered = new Promise<void>((resolve) => {
      reached = resolve
    })
    f.setChallenge(async () => {
      if (++entered === 8) reached?.()
      await gate
      return { ok: true, challenge: f.challenge }
    })
    const pending = Array.from({ length: 8 }, () =>
      pauseAuthorityRequest(f.event(), f.runtime, 'challenges'),
    )
    const settled = Promise.allSettled(pending)
    try {
      await allEntered
      f.service.close()
      await assert.rejects(
        pauseAuthorityRequest(f.event(), f.runtime, 'challenges'),
        { status: 503 },
      )
    } finally {
      release?.()
    }
    for (const result of await settled) {
      assert.equal(result.status, 'fulfilled')
      if (result.status === 'fulfilled')
        assert.deepEqual(result.value, { challenge: f.challenge })
    }
    await assert.rejects(
      pauseAuthorityRequest(f.event(), f.runtime, 'challenges'),
      { status: 403 },
    )
  },
)

test(
  'aborted body retains its request slot until actual cancel settles',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t)
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const signal = new AbortController()
    let cancelling: (() => void) | undefined
    const cancelled = new Promise<void>((resolve) => {
      cancelling = resolve
    })
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelling?.()
        return gate
      },
    })
    const request = streamedRequest(
      'https://farm.example.invalid/api/pause-authority/challenges',
      {
        method: 'POST',
        headers: {
          cookie: f.cookie,
          origin: f.binding.origin,
          'content-type': 'application/json',
        },
        body: stream,
        duplex: 'half',
        signal: signal.signal,
      },
    )
    let settled = false
    let quotaReached: (() => void) | undefined
    const entered = new Promise<void>((resolve) => {
      quotaReached = resolve
    })
    t.mock.method(f.runtime.auth.credentials, 'consumeLimit', async () => {
      quotaReached?.()
      return true
    })
    const failed = assert
      .rejects(
        pauseAuthorityRequest(
          {
            req: request,
            res: { status: 200, statusText: 'OK', headers: new Headers() },
          },
          f.runtime,
          'challenges',
        ),
        { status: 408 },
      )
      .then(() => {
        settled = true
      })
    try {
      await entered
      await Promise.resolve()
      signal.abort()
      await cancelled
      assert.equal(settled, false)
    } finally {
      release?.()
    }
    await failed
  },
)

test(
  'immediately resolved reads cannot outrun the absolute monotonic body deadline',
  { timeout: 10000 },
  async (t) => {
    let samples = 0,
      cancellations = 0
    t.mock.method(performance, 'now', () => (++samples < 3 ? 100 : 5100))
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{}'))
      },
      cancel() {
        cancellations++
      },
    })
    const request = streamedRequest('https://farm.invalid/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      duplex: 'half',
    })
    await assert.rejects(readPauseAuthorityBody(request, 'challenges'), {
      status: 408,
    })
    assert.equal(cancellations, 1)
  },
)
