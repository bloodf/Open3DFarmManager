import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  createPauseCommandIssuer,
  PauseCommandIssuerError,
} from '../../apps/farm/app/utils/webrtc/pause-command-issuer.ts'
import { base64url } from '../../packages/farm-protocol/src/encoding.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import {
  PauseAdmissionChallenge,
  signPauseCapability,
} from '../../packages/farm-protocol/src/pause-capability.ts'

/** A coordinate of the maintained shape: 32 bytes as base64url. */
const coordinate = () => base64url(randomBytes(32))

type FetchCall = { url: string; init: RequestInit }

/** A fetch double. It records the calls and never touches the network. */
function stubFetch(
  handler: (call: FetchCall) => Response | Promise<Response>,
): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} }
    calls.push(call)
    return await handler(call)
  }) as unknown as typeof globalThis.fetch
  return { fetch: impl, calls }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** A tracked stream. It stays open, so a cancellation reaches the source. */
function trackedStream(chunks: Uint8Array[]): {
  stream: ReadableStream<Uint8Array>
  cancelled: () => boolean
} {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
    },
    cancel() {
      cancelled = true
    },
  })
  return { stream, cancelled: () => cancelled }
}

/** A stream that keeps producing bytes, one chunk at a time, until cancelled. */
function endlessStream(): {
  stream: ReadableStream<Uint8Array>
  cancelled: () => boolean
} {
  let cancelled = false
  let pending = false
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pending || cancelled) return
      pending = true
      setTimeout(() => {
        pending = false
        if (cancelled) return
        try {
          controller.enqueue(new TextEncoder().encode('{"challenge":'))
        } catch {
          cancelled = true
        }
      }, 25)
    },
    cancel() {
      cancelled = true
    },
  })
  return { stream, cancelled: () => cancelled }
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for state')
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/**
 * Real enrollment material. The browser key is nonextractable, the issuer key
 * signs a real capability and no authority decision is stubbed.
 */
async function issuerFixture() {
  const browser = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const jwk = await crypto.subtle.exportKey('jwk', browser.publicKey)
  const identity = await validateBrowserDevicePublicKey({
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
  })
  const issuerKey = (
    await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify'])
  ).privateKey
  const now = Date.now()
  const challenge = PauseAdmissionChallenge.parse({
    v: 1,
    purpose: 'pause-admission',
    challenge_id: randomUUID(),
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    key_id: randomUUID(),
    assignment_id: randomUUID(),
    transport_id: randomUUID(),
    account_id: 'legacy_account',
    browser_thumbprint: identity.thumbprint,
    origin: 'https://farm.example',
    audience: 'open3dfarmmanager:pause',
    control_binding_sha256: coordinate(),
    admission_nonce: coordinate(),
    issued_at: now,
    expires_at: now + 8_000,
  })
  const capability = await signPauseCapability(
    {
      v: 1,
      purpose: 'pause-authority',
      capability_id: randomUUID(),
      kid: 'pause-issuer-1',
      issuer: 'open3dfarmmanager:pause',
      audience: 'open3dfarmmanager:pause',
      origin: 'https://farm.example',
      issued_at: now,
      expires_at: now + 30_000,
      account_id: 'legacy_account',
      role: 'owner',
      farm_id: randomUUID(),
      agent_id: randomUUID(),
      key_id: randomUUID(),
      assignment_id: randomUUID(),
      transport_id: randomUUID(),
      browser_public_key: identity.publicKey,
      browser_thumbprint: identity.thumbprint,
      connector_fingerprint: `SHA256:${coordinate()}`,
      credential_jti: randomUUID(),
      printer_key: 'printer-key-1',
      control_binding_sha256: coordinate(),
      admission_nonce: coordinate(),
      actions: ['pause'],
    },
    issuerKey,
  )
  return { challenge, capability }
}

test('the factory is inert and creates no key', async () => {
  const stub = stubFetch(() => {
    throw new Error('no request is expected')
  })
  createPauseCommandIssuer({
    currentOrigin: 'https://farm.example',
    fetch: stub.fetch,
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stub.calls.length, 0)
  const source = readFileSync(
    new URL(
      '../../apps/farm/app/utils/webrtc/pause-command-issuer.ts',
      import.meta.url,
    ),
    'utf8',
  )
  assert.doesNotMatch(source, /crypto\.subtle|generateKey|importKey/)
})

test('the challenge request uses the maintained route, body and flags', async () => {
  const { challenge } = await issuerFixture()
  const stub = stubFetch(() => jsonResponse({ challenge }))
  const issuer = createPauseCommandIssuer({
    currentOrigin: 'https://farm.example',
    fetch: stub.fetch,
  })
  const admissionNonce = challenge.admission_nonce
  const result = await issuer.challenge({
    browserProofWire: 'browser-proof',
    connectorProofWire: 'connector-proof',
    admissionNonce,
    signal: new AbortController().signal,
  })
  assert.equal(stub.calls.length, 1)
  const call = stub.calls[0]!
  assert.equal(call.url, 'https://farm.example/api/pause-authority/challenges')
  assert.equal(call.init.method, 'POST')
  assert.equal(call.init.credentials, 'same-origin')
  assert.equal(call.init.cache, 'no-store')
  assert.equal(call.init.redirect, 'error')
  assert.deepEqual(call.init.headers, { 'content-type': 'application/json' })
  assert.deepEqual(JSON.parse(String(call.init.body)), {
    browserProofWire: 'browser-proof',
    connectorProofWire: 'connector-proof',
    admissionNonce,
  })
  assert.deepEqual(result, challenge)
})

test('the capability request uses the maintained route, body and flags', async () => {
  const { capability } = await issuerFixture()
  const stub = stubFetch(() => jsonResponse({ capability }))
  const issuer = createPauseCommandIssuer({
    currentOrigin: 'https://farm.example',
    fetch: stub.fetch,
  })
  const result = await issuer.capability({
    admissionProofWire: 'admission-proof',
    signal: new AbortController().signal,
  })
  assert.equal(stub.calls.length, 1)
  const call = stub.calls[0]!
  assert.equal(
    call.url,
    'https://farm.example/api/pause-authority/capabilities',
  )
  assert.equal(call.init.method, 'POST')
  assert.equal(call.init.credentials, 'same-origin')
  assert.equal(call.init.cache, 'no-store')
  assert.equal(call.init.redirect, 'error')
  assert.deepEqual(call.init.headers, { 'content-type': 'application/json' })
  assert.deepEqual(JSON.parse(String(call.init.body)), {
    admissionProofWire: 'admission-proof',
  })
  assert.deepEqual(result, capability)
})

test('a response that is not the maintained envelope fails closed', async () => {
  const { challenge, capability } = await issuerFixture()
  const cases: Array<{
    name: string
    body: unknown
    operation: 'challenge' | 'capability'
  }> = [
    {
      name: 'unknown envelope field',
      body: { challenge, extra: 1 },
      operation: 'challenge',
    },
    {
      name: 'unknown capability envelope field',
      body: { capability, extra: 1 },
      operation: 'capability',
    },
    {
      name: 'wrong challenge type',
      body: { challenge: 5 },
      operation: 'challenge',
    },
    {
      name: 'wrong capability type',
      body: { capability: 'issued' },
      operation: 'capability',
    },
    { name: 'missing challenge', body: {}, operation: 'challenge' },
    {
      name: 'challenge with unknown field',
      body: { challenge: { ...challenge, extra: 1 } },
      operation: 'challenge',
    },
  ]
  for (const scenario of cases) {
    const stub = stubFetch(() => jsonResponse(scenario.body))
    const issuer = createPauseCommandIssuer({
      currentOrigin: 'https://farm.example',
      fetch: stub.fetch,
    })
    const work =
      scenario.operation === 'challenge'
        ? issuer.challenge({
            browserProofWire: 'browser-proof',
            connectorProofWire: 'connector-proof',
            admissionNonce: challenge.admission_nonce,
            signal: new AbortController().signal,
          })
        : issuer.capability({
            admissionProofWire: 'admission-proof',
            signal: new AbortController().signal,
          })
    await assert.rejects(
      work,
      (error: unknown) => {
        assert.ok(error instanceof PauseCommandIssuerError)
        assert.equal(error.reason, 'response')
        return true
      },
      scenario.name,
    )
  }
})

test('a duplicate key fails closed', async () => {
  const { challenge } = await issuerFixture()
  const body = `{"challenge":${JSON.stringify(challenge)},"challenge":${JSON.stringify(challenge)}}`
  const stub = stubFetch(() => new Response(body, { status: 200 }))
  const issuer = createPauseCommandIssuer({
    currentOrigin: 'https://farm.example',
    fetch: stub.fetch,
  })
  await assert.rejects(
    issuer.challenge({
      browserProofWire: 'browser-proof',
      connectorProofWire: 'connector-proof',
      admissionNonce: challenge.admission_nonce,
      signal: new AbortController().signal,
    }),
    (error: unknown) => {
      assert.ok(error instanceof PauseCommandIssuerError)
      assert.equal(error.reason, 'response')
      return true
    },
  )
})

test('an invalid encoding fails closed', async () => {
  const { challenge } = await issuerFixture()
  const tracked = trackedStream([new Uint8Array([0xff, 0xfe, 0x41])])
  const stub = stubFetch(() => new Response(tracked.stream, { status: 200 }))
  const issuer = createPauseCommandIssuer({
    currentOrigin: 'https://farm.example',
    fetch: stub.fetch,
  })
  await assert.rejects(
    issuer.challenge({
      browserProofWire: 'browser-proof',
      connectorProofWire: 'connector-proof',
      admissionNonce: challenge.admission_nonce,
      signal: new AbortController().signal,
    }),
    (error: unknown) => {
      assert.ok(error instanceof PauseCommandIssuerError)
      assert.equal(error.reason, 'response')
      return true
    },
  )
  assert.equal(tracked.cancelled(), true)
})

test('the response size limit is enforced on the raw stream', async () => {
  const { challenge } = await issuerFixture()
  const payload = JSON.stringify({ challenge })
  const padded = ' '.repeat(16_384 - payload.length) + payload
  assert.equal(new TextEncoder().encode(padded).byteLength, 16_384)
  const accepted = stubFetch(() => new Response(padded, { status: 200 }))
  const issuer = createPauseCommandIssuer({
    currentOrigin: 'https://farm.example',
    fetch: accepted.fetch,
  })
  const result = await issuer.challenge({
    browserProofWire: 'browser-proof',
    connectorProofWire: 'connector-proof',
    admissionNonce: challenge.admission_nonce,
    signal: new AbortController().signal,
  })
  assert.deepEqual(result, challenge)

  const oversized = trackedStream([
    new TextEncoder().encode('a'.repeat(16_385)),
  ])
  const rejected = stubFetch(
    () => new Response(oversized.stream, { status: 200 }),
  )
  const strict = createPauseCommandIssuer({
    currentOrigin: 'https://farm.example',
    fetch: rejected.fetch,
  })
  await assert.rejects(
    strict.challenge({
      browserProofWire: 'browser-proof',
      connectorProofWire: 'connector-proof',
      admissionNonce: challenge.admission_nonce,
      signal: new AbortController().signal,
    }),
    (error: unknown) => {
      assert.ok(error instanceof PauseCommandIssuerError)
      assert.equal(error.reason, 'response')
      return true
    },
  )
  assert.equal(oversized.cancelled(), true)
})

test('a wrong status, a redirect and a missing body fail closed', async () => {
  const { challenge } = await issuerFixture()
  const request = (issuer: ReturnType<typeof createPauseCommandIssuer>) =>
    issuer.challenge({
      browserProofWire: 'browser-proof',
      connectorProofWire: 'connector-proof',
      admissionNonce: challenge.admission_nonce,
      signal: new AbortController().signal,
    })

  const denied = stubFetch(() => jsonResponse({ challenge }, 403))
  const deniedIssuer = createPauseCommandIssuer({
    currentOrigin: 'https://farm.example',
    fetch: denied.fetch,
  })
  await assert.rejects(request(deniedIssuer), (error: unknown) => {
    assert.ok(error instanceof PauseCommandIssuerError)
    assert.equal(error.reason, 'status')
    return true
  })

  const redirected = stubFetch(
    () =>
      ({
        redirected: true,
        type: 'basic',
        status: 200,
        body: trackedStream([]).stream,
      }) as unknown as Response,
  )
  const redirectIssuer = createPauseCommandIssuer({
    currentOrigin: 'https://farm.example',
    fetch: redirected.fetch,
  })
  await assert.rejects(request(redirectIssuer), (error: unknown) => {
    assert.ok(error instanceof PauseCommandIssuerError)
    assert.equal(error.reason, 'response')
    return true
  })

  const empty = stubFetch(() => new Response(null, { status: 200 }))
  const emptyIssuer = createPauseCommandIssuer({
    currentOrigin: 'https://farm.example',
    fetch: empty.fetch,
  })
  await assert.rejects(request(emptyIssuer), (error: unknown) => {
    assert.ok(error instanceof PauseCommandIssuerError)
    assert.equal(error.reason, 'response')
    return true
  })
})

test('the request deadline is two seconds and is never renewed', async () => {
  const { challenge } = await issuerFixture()
  const pending = new Promise<Response>(() => {})
  const stub = stubFetch(() => pending)
  const issuer = createPauseCommandIssuer({
    currentOrigin: 'https://farm.example',
    fetch: stub.fetch,
  })
  const started = Date.now()
  await assert.rejects(
    issuer.challenge({
      browserProofWire: 'browser-proof',
      connectorProofWire: 'connector-proof',
      admissionNonce: challenge.admission_nonce,
      signal: new AbortController().signal,
    }),
    (error: unknown) => {
      assert.ok(error instanceof PauseCommandIssuerError)
      assert.equal(error.reason, 'timeout')
      return true
    },
  )
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 1_900, `deadline was ${elapsed}ms`)
  assert.ok(elapsed < 5_000, `deadline was ${elapsed}ms`)
  const signal = stub.calls[0]!.init.signal
  assert.ok(signal instanceof AbortSignal)
  assert.equal(signal.aborted, true)
})

test('a body that keeps arriving does not renew the deadline', async () => {
  const { challenge } = await issuerFixture()
  const endless = endlessStream()
  const stub = stubFetch(() => new Response(endless.stream, { status: 200 }))
  const issuer = createPauseCommandIssuer({
    currentOrigin: 'https://farm.example',
    fetch: stub.fetch,
  })
  const started = Date.now()
  await assert.rejects(
    issuer.challenge({
      browserProofWire: 'browser-proof',
      connectorProofWire: 'connector-proof',
      admissionNonce: challenge.admission_nonce,
      signal: new AbortController().signal,
    }),
    (error: unknown) => {
      assert.ok(error instanceof PauseCommandIssuerError)
      assert.equal(error.reason, 'timeout')
      return true
    },
  )
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 1_900, `deadline was ${elapsed}ms`)
  assert.ok(elapsed < 5_000, `deadline was ${elapsed}ms`)
  assert.equal(endless.cancelled(), true)
})

test('the caller abort cancels the request', async () => {
  const { challenge } = await issuerFixture()
  const pending = new Promise<Response>(() => {})
  const stub = stubFetch(() => pending)
  const issuer = createPauseCommandIssuer({
    currentOrigin: 'https://farm.example',
    fetch: stub.fetch,
  })
  const controller = new AbortController()
  const work = issuer.challenge({
    browserProofWire: 'browser-proof',
    connectorProofWire: 'connector-proof',
    admissionNonce: challenge.admission_nonce,
    signal: controller.signal,
  })
  await waitFor(() => stub.calls.length === 1)
  controller.abort()
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof PauseCommandIssuerError)
    assert.equal(error.reason, 'aborted')
    return true
  })
  const signal = stub.calls[0]!.init.signal
  assert.ok(signal instanceof AbortSignal)
  assert.equal(signal.aborted, true)
})

test('a late response is disposed and never delivered', async () => {
  const { challenge } = await issuerFixture()
  const late = trackedStream([
    new TextEncoder().encode(JSON.stringify({ challenge })),
  ])
  const stub = stubFetch(async () => {
    await new Promise((resolve) => setTimeout(resolve, 2_200))
    return new Response(late.stream, { status: 200 })
  })
  const issuer = createPauseCommandIssuer({
    currentOrigin: 'https://farm.example',
    fetch: stub.fetch,
  })
  await assert.rejects(
    issuer.challenge({
      browserProofWire: 'browser-proof',
      connectorProofWire: 'connector-proof',
      admissionNonce: challenge.admission_nonce,
      signal: new AbortController().signal,
    }),
    (error: unknown) => {
      assert.ok(error instanceof PauseCommandIssuerError)
      assert.equal(error.reason, 'timeout')
      return true
    },
  )
  await waitFor(() => late.cancelled())
  assert.equal(late.cancelled(), true)
})

test('a missing caller signal fails closed without a request', async () => {
  const { challenge } = await issuerFixture()
  const stub = stubFetch(() => jsonResponse({ challenge }))
  const issuer = createPauseCommandIssuer({
    currentOrigin: 'https://farm.example',
    fetch: stub.fetch,
  })
  await assert.rejects(
    issuer.challenge({
      browserProofWire: 'browser-proof',
      connectorProofWire: 'connector-proof',
      admissionNonce: challenge.admission_nonce,
    } as unknown as Parameters<typeof issuer.challenge>[0]),
    (error: unknown) => {
      assert.ok(error instanceof PauseCommandIssuerError)
      assert.equal(error.reason, 'aborted')
      return true
    },
  )
  assert.equal(stub.calls.length, 0)
})

test('an origin that is not the current HTTPS origin fails closed', async () => {
  const { challenge } = await issuerFixture()
  for (const origin of [
    'http://farm.example',
    'https://farm.example/path',
    'not-a-url',
  ]) {
    const stub = stubFetch(() => jsonResponse({ challenge }))
    const issuer = createPauseCommandIssuer({
      currentOrigin: origin,
      fetch: stub.fetch,
    })
    await assert.rejects(
      issuer.challenge({
        browserProofWire: 'browser-proof',
        connectorProofWire: 'connector-proof',
        admissionNonce: challenge.admission_nonce,
        signal: new AbortController().signal,
      }),
      (error: unknown) => {
        assert.ok(error instanceof PauseCommandIssuerError)
        assert.equal(error.reason, 'origin')
        return true
      },
      origin,
    )
    assert.equal(stub.calls.length, 0)
  }
})

test('a request outside the maintained shape fails closed', async () => {
  const { challenge } = await issuerFixture()
  const stub = stubFetch(() => jsonResponse({ challenge }))
  const issuer = createPauseCommandIssuer({
    currentOrigin: 'https://farm.example',
    fetch: stub.fetch,
  })
  await assert.rejects(
    issuer.challenge({
      browserProofWire: 'b'.repeat(8_193),
      connectorProofWire: 'connector-proof',
      admissionNonce: challenge.admission_nonce,
      signal: new AbortController().signal,
    }),
    (error: unknown) => {
      assert.ok(error instanceof PauseCommandIssuerError)
      assert.equal(error.reason, 'request')
      return true
    },
  )
  await assert.rejects(
    issuer.challenge({
      browserProofWire: 'browser-proof',
      connectorProofWire: 'connector-proof',
      admissionNonce: 'not-a-nonce',
      signal: new AbortController().signal,
    }),
    (error: unknown) => {
      assert.ok(error instanceof PauseCommandIssuerError)
      assert.equal(error.reason, 'request')
      return true
    },
  )
  assert.equal(stub.calls.length, 0)
})
