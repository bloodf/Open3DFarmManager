import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
async function commandFixture() {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const { kty, crv, x, y } = await crypto.subtle.exportKey(
    'jwk',
    pair.publicKey,
  )
  const { validateBrowserDevicePublicKey } =
    await import('../../packages/farm-protocol/src/browser-device-proof.ts')
  const { publicKey } = await validateBrowserDevicePublicKey({ kty, crv, x, y })
  const command = {
    v: 2 as const,
    purpose: 'printer-pause' as const,
    cmd_id: randomUUID(),
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    account_id: 'legacy_account',
    key_id: randomUUID(),
    transport_id: randomUUID(),
    capability_id: randomUUID(),
    assignment_id: randomUUID(),
    action: 'pause' as const,
    args: {},
    issued_at: 1000,
    expires_at: 6000,
    nonce: randomBytes(16).toString('base64url'),
  }
  return { pair, publicKey, command }
}

async function authorityFixture() {
  const { pair, publicKey, command } = await commandFixture()
  const { validateBrowserDevicePublicKey } =
    await import('../../packages/farm-protocol/src/browser-device-proof.ts')
  const { thumbprint } = await validateBrowserDevicePublicKey(publicKey)
  const issuer = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const connector = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const spki = Buffer.from(
    await crypto.subtle.exportKey('spki', connector.publicKey),
  )
  const { createHash } = await import('node:crypto')
  const digest = () => randomBytes(32).toString('base64url')
  const binding = {
    v: 1 as const,
    purpose: 'pause-rtc' as const,
    transport_id: command.transport_id,
    farm_id: command.farm_id,
    agent_id: command.agent_id,
    account_id: command.account_id,
    key_id: command.key_id,
    assignment_id: command.assignment_id,
    browser_public_key: publicKey,
    browser_thumbprint: thumbprint,
    connector_public_key_spki: spki.toString('base64url'),
    connector_fingerprint:
      'SHA256:' + createHash('sha256').update(spki).digest('base64url'),
    credential_jti: randomUUID(),
    origin: 'https://farm.example',
    audience: 'open3dfarmmanager:pause',
    browser_nonce: digest(),
    connector_nonce: digest(),
    issued_at: 1000,
    expires_at: 30000,
    offer_sha256: digest(),
    answer_sha256: digest(),
    browser_dtls: Array(32).fill('AA').join(':'),
    connector_dtls: Array(32).fill('BB').join(':'),
  }
  const { controlBindingHash } =
    await import('../../packages/farm-protocol/src/control-session-binding.ts')
  const bindingHash = await controlBindingHash(binding),
    admissionNonce = digest()
  const capability = {
    v: 1 as const,
    purpose: 'pause-authority' as const,
    capability_id: command.capability_id,
    kid: 'issuer-1',
    issuer: 'farm:issuer',
    audience: binding.audience,
    origin: binding.origin,
    issued_at: 1000,
    expires_at: 30000,
    account_id: command.account_id,
    role: 'operator' as const,
    farm_id: binding.farm_id,
    agent_id: binding.agent_id,
    key_id: binding.key_id,
    assignment_id: binding.assignment_id,
    transport_id: binding.transport_id,
    browser_public_key: publicKey,
    browser_thumbprint: thumbprint,
    connector_fingerprint: binding.connector_fingerprint,
    credential_jti: binding.credential_jti,
    printer_key: 'é"\\'.repeat(32),
    control_binding_sha256: bindingHash,
    admission_nonce: admissionNonce,
    actions: ['pause'] as ['pause'],
  }
  const challenge = {
    v: 1 as const,
    purpose: 'pause-admission' as const,
    challenge_id: randomUUID(),
    farm_id: binding.farm_id,
    agent_id: binding.agent_id,
    key_id: binding.key_id,
    assignment_id: binding.assignment_id,
    transport_id: binding.transport_id,
    account_id: binding.account_id,
    browser_thumbprint: thumbprint,
    origin: binding.origin,
    audience: binding.audience,
    control_binding_sha256: bindingHash,
    admission_nonce: admissionNonce,
    issued_at: 1000,
    expires_at: 9000,
  }
  return {
    pair,
    publicKey,
    command,
    issuer,
    connector,
    binding,
    capability,
    challenge,
  }
}

async function inputs() {
  const f = await authorityFixture()
  const control =
    await import('../../packages/farm-protocol/src/control-session-binding.ts')
  const browserSignature = await control.signControlSessionProof(
    f.binding,
    'browser',
    f.pair.privateKey,
  )
  const connectorSignature = await control.signControlSessionProof(
    f.binding,
    'connector',
    f.connector.privateKey,
  )
  const request = {
    browserProofWire: control.encodeControlProof({
      v: 1,
      role: 'browser',
      binding: f.binding,
      signature: browserSignature,
    }),
    connectorProofWire: control.encodeControlProof({
      v: 1,
      role: 'connector',
      binding: f.binding,
      signature: connectorSignature,
    }),
    admissionNonce: f.challenge.admission_nonce,
  }
  const config = {
    origin: f.binding.origin,
    audience: f.binding.audience,
    issuer: f.capability.issuer,
    kid: f.capability.kid,
    credentialIssuer: 'connector:issuer',
    credentialAudience: 'connector:audience',
    idleTimeoutMs: 1800000 as const,
    signingKey: f.issuer.privateKey,
    verificationKey: f.issuer.publicKey,
  }
  return { f, request, config }
}

test('issuer service rejects noncanonical, wrong role, extra command and identity fields before storage', async () => {
  const f = await inputs()
  const { PostgresPauseAuthority } =
    await import('../../apps/farm/server/storage/postgres-pause-authority.ts')
  const { createPauseAuthorityService } =
    await import('../../apps/farm/server/services/pause-authority.ts')
  const postgres = (await import('postgres')).default
  const sql = postgres({
    host: '127.0.0.1',
    port: 1,
    database: 'fixture',
    username: 'fixture',
    connect_timeout: 1,
  })
  const original = PostgresPauseAuthority.prototype.issueChallenge
  let calls = 0
  PostgresPauseAuthority.prototype.issueChallenge = async () => {
    calls++
    return { ok: false, reason: 'denied' }
  }
  try {
    const service = createPauseAuthorityService(sql, f.config)
    const control =
      await import('../../packages/farm-protocol/src/control-session-binding.ts')
    const otherBinding = { ...f.f.binding, transport_id: randomUUID() }
    const mismatched = control.encodeControlProof({
      v: 1,
      role: 'connector',
      binding: otherBinding,
      signature: await control.signControlSessionProof(
        otherBinding,
        'connector',
        f.f.connector.privateKey,
      ),
    })
    for (const input of [
      {
        sessionRecordId: 'session',
        request: { ...f.request, command: { action: 'pause' } },
      },
      {
        sessionRecordId: 'session',
        request: { ...f.request, account_id: 'other' },
      },
      {
        sessionRecordId: 'session',
        request: {
          ...f.request,
          browserProofWire: ' ' + f.request.browserProofWire,
        },
      },
      {
        sessionRecordId: 'session',
        request: {
          ...f.request,
          connectorProofWire: f.request.browserProofWire,
        },
      },
      {
        sessionRecordId: 'session',
        request: { ...f.request, connectorProofWire: mismatched },
      },
    ])
      assert.deepEqual(await service.issueChallenge(input), {
        ok: false,
        reason: 'invalid-input',
      })
    assert.equal(calls, 0)
    assert.deepEqual(
      await service.issueChallenge({
        sessionRecordId: 'session',
        request: f.request,
      }),
      { ok: false, reason: 'denied' },
    )
    assert.equal(calls, 1)
    service.close()
  } finally {
    PostgresPauseAuthority.prototype.issueChallenge = original
    await sql.end({ timeout: 1 })
  }
})

test('eight in-flight operations retain capacity across service instances and close preserves settled result', async () => {
  const f = await inputs()
  const { PostgresPauseAuthority } =
    await import('../../apps/farm/server/storage/postgres-pause-authority.ts')
  const { createPauseAuthorityService } =
    await import('../../apps/farm/server/services/pause-authority.ts')
  const postgres = (await import('postgres')).default
  const sql = postgres({
    host: '127.0.0.1',
    port: 1,
    database: 'fixture',
    username: 'fixture',
    connect_timeout: 1,
  })
  const original = PostgresPauseAuthority.prototype.issueChallenge
  const releases: Array<() => void> = []
  PostgresPauseAuthority.prototype.issueChallenge = async () => {
    await new Promise<void>((resolve) => releases.push(resolve))
    return { ok: false, reason: 'denied' }
  }
  try {
    const first = createPauseAuthorityService(sql, f.config),
      second = createPauseAuthorityService(sql, f.config)
    const pending = Array.from({ length: 8 }, (_, index) =>
      (index % 2 ? first : second).issueChallenge({
        sessionRecordId: 'session',
        request: f.request,
      }),
    )
    assert.equal(releases.length, 8)
    assert.deepEqual(
      await first.issueChallenge({
        sessionRecordId: 'session',
        request: f.request,
      }),
      { ok: false, reason: 'capacity' },
    )
    first.close()
    assert.deepEqual(
      await first.issueChallenge({
        sessionRecordId: 'session',
        request: f.request,
      }),
      { ok: false, reason: 'denied' },
    )
    for (const release of releases) release()
    assert.deepEqual(
      await Promise.all(pending),
      Array(8).fill({ ok: false, reason: 'denied' }),
    )
    second.close()
  } finally {
    PostgresPauseAuthority.prototype.issueChallenge = original
    for (const release of releases) release()
    await sql.end({ timeout: 1 })
  }
})

test('issuer boundary accepts canonical native proofs and only returns fixed signed metadata', async () => {
  const f = await inputs()
  const caps =
    await import('../../packages/farm-protocol/src/pause-capability.ts')
  const { PostgresPauseAuthority } =
    await import('../../apps/farm/server/storage/postgres-pause-authority.ts')
  const { createPauseAuthorityService } =
    await import('../../apps/farm/server/services/pause-authority.ts')
  const postgres = (await import('postgres')).default
  const sql = postgres({
    host: '127.0.0.1',
    port: 1,
    database: 'fixture',
    username: 'fixture',
    connect_timeout: 1,
  })
  const oldChallenge = PostgresPauseAuthority.prototype.issueChallenge,
    oldCapability = PostgresPauseAuthority.prototype.issueCapability
  const signed = await caps.signPauseCapability(
    f.f.capability,
    f.f.issuer.privateKey,
  )
  const proof = await caps.signPauseAdmissionProof(
    f.f.challenge,
    f.f.pair.privateKey,
  )
  PostgresPauseAuthority.prototype.issueChallenge = async () => ({
    ok: true,
    challenge: f.f.challenge,
  })
  PostgresPauseAuthority.prototype.issueCapability = async () => ({
    ok: true,
    capability: signed,
  })
  try {
    const service = createPauseAuthorityService(sql, f.config)
    const first = await service.issueChallenge({
      sessionRecordId: 'private_login',
      request: f.request,
    })
    assert.ok(first.ok)
    assert.deepEqual(first.challenge, f.f.challenge)
    const second = await service.issueCapability({
      sessionRecordId: 'private_login',
      request: { admissionProofWire: caps.encodePauseAdmissionProof(proof) },
    })
    assert.ok(second.ok)
    assert.equal(
      await caps.verifyPauseCapability(second.capability, f.f.issuer.publicKey),
      true,
    )
    assert.equal(JSON.stringify(second).includes('private_login'), false)
    assert.equal(Object.isFrozen(second.capability), true)
    assert.deepEqual(
      await service.issueCapability({
        sessionRecordId: 'private_login',
        request: {
          admissionProofWire: caps.encodePauseAdmissionProof(proof),
          action: 'pause',
        },
      }),
      { ok: false, reason: 'invalid-input' },
    )
    service.close()
  } finally {
    PostgresPauseAuthority.prototype.issueChallenge = oldChallenge
    PostgresPauseAuthority.prototype.issueCapability = oldCapability
    await sql.end({ timeout: 1 })
  }
})

test('caller mutation after invocation cannot alter stored request and thrown errors are sanitized', async () => {
  const f = await inputs()
  const { PostgresPauseAuthority } =
    await import('../../apps/farm/server/storage/postgres-pause-authority.ts')
  const { createPauseAuthorityService } =
    await import('../../apps/farm/server/services/pause-authority.ts')
  const postgres = (await import('postgres')).default
  const sql = postgres({
    host: '127.0.0.1',
    port: 1,
    database: 'fixture',
    username: 'fixture',
    connect_timeout: 1,
  })
  const original = PostgresPauseAuthority.prototype.issueChallenge
  let observed = '',
    release: () => void = () => {}
  PostgresPauseAuthority.prototype.issueChallenge = async (input) => {
    await new Promise<void>((resolve) => {
      release = resolve
    })
    if (
      typeof input !== 'object' ||
      input === null ||
      !('request' in input) ||
      typeof input.request !== 'object' ||
      input.request === null ||
      !('admissionNonce' in input.request) ||
      typeof input.request.admissionNonce !== 'string'
    )
      throw new Error('invalid fixture input')
    observed = input.request.admissionNonce
    throw new Error('private synthetic detail')
  }
  try {
    const service = createPauseAuthorityService(sql, f.config),
      nonce = f.request.admissionNonce
    const input = { sessionRecordId: 'session', request: { ...f.request } }
    const pending = service.issueChallenge(input)
    input.request.admissionNonce = 'A'.repeat(43)
    release()
    assert.deepEqual(await pending, {
      ok: false,
      reason: 'storage-unavailable',
    })
    assert.equal(observed, nonce)
    service.close()
  } finally {
    PostgresPauseAuthority.prototype.issueChallenge = original
    release()
    await sql.end({ timeout: 1 })
  }
})

test('issuer key mismatch, extractability and policy bounds fail before any database transaction', async () => {
  const f = await inputs()
  const { PostgresPauseAuthority } =
    await import('../../apps/farm/server/storage/postgres-pause-authority.ts')
  const postgres = (await import('postgres')).default
  const sql = postgres({
    host: '127.0.0.1',
    port: 1,
    database: 'fixture',
    username: 'fixture',
    connect_timeout: 1,
  })
  try {
    const other = await crypto.subtle.generateKey('Ed25519', false, [
      'sign',
      'verify',
    ])
    const mismatched = new PostgresPauseAuthority(sql, {
      ...f.config,
      verificationKey: other.publicKey,
    })
    assert.deepEqual(
      await mismatched.issueChallenge({
        sessionRecordId: 'session',
        request: f.request,
      }),
      { ok: false, reason: 'invalid-input' },
    )
    const extractable = await crypto.subtle.generateKey('Ed25519', true, [
      'sign',
      'verify',
    ])
    assert.throws(
      () =>
        new PostgresPauseAuthority(sql, {
          ...f.config,
          signingKey: extractable.privateKey,
        }),
    )
    assert.throws(
      () =>
        new PostgresPauseAuthority(sql, {
          ...f.config,
          signingKey: f.f.pair.privateKey,
        }),
    )
    for (const value of [0, NaN, Infinity, 30001])
      assert.throws(
        () =>
          new PostgresPauseAuthority(sql, {
            ...f.config,
            policy: { capabilityMs: value },
          }),
      )
    assert.doesNotThrow(
      () =>
        new PostgresPauseAuthority(sql, {
          ...f.config,
          policy: { capabilityMs: 1000 },
        }),
    )
  } finally {
    await sql.end({ timeout: 1 })
  }
})

test('postcommit delayed clock response cannot extend an earlier admission deadline', async () => {
  const f = await inputs()
  const caps =
    await import('../../packages/farm-protocol/src/pause-capability.ts')
  const { PostgresPauseAuthority } =
    await import('../../apps/farm/server/storage/postgres-pause-authority.ts')
  const postgres = (await import('postgres')).default
  const backing = postgres({
    host: '127.0.0.1',
    port: 1,
    database: 'fixture',
    username: 'fixture',
    connect_timeout: 1,
  })
  const signed = await caps.signPauseCapability(
    f.f.capability,
    f.f.issuer.privateKey,
  )
  // Synthetic SQL adapter isolates postcommit time accounting; it is not DB acceptance.
  let transactions = 0,
    delayPoint: 'response' | 'commit' = 'commit'
  const sql = new Proxy(backing, {
    get(target, property, receiver) {
      if (property === 'begin')
        return async (
          callback: (
            tx: (strings: TemplateStringsArray) => Promise<unknown>,
          ) => Promise<void>,
        ) => {
          transactions++
          await callback(async (strings) => {
            if (!strings.join('').includes('SELECT floor(')) return []
            if (delayPoint === 'response')
              await new Promise((resolve) => setTimeout(resolve, 20))
            return [{ now: 1000, watermark: 1000 }]
          })
          if (transactions === 2 && delayPoint === 'commit')
            await new Promise((resolve) => setTimeout(resolve, 20))
        }
      return Reflect.get(target, property, receiver)
    },
  })
  try {
    const authority = new PostgresPauseAuthority(sql, f.config)
    const transaction = Reflect.get(authority, 'transaction')
    assert.equal(typeof transaction, 'function')
    const control = await Reflect.apply(transaction, authority, [
      async (_tx: unknown, setDeadline: (n: number) => void) => {
        setDeadline(f.f.challenge.expires_at)
        return { ok: true, capability: signed }
      },
    ])
    assert.deepEqual(control, { ok: true, capability: signed })
    assert.equal(transactions, 2)
    transactions = 0
    const result = await Reflect.apply(transaction, authority, [
      async (_tx: unknown, setDeadline: (n: number) => void) => {
        setDeadline(1005)
        return { ok: true, capability: signed }
      },
    ])
    assert.deepEqual(result, { ok: false, reason: 'denied' })
    assert.equal(transactions, 2)
    transactions = 0
    delayPoint = 'response'
    const responseDelay = await Reflect.apply(transaction, authority, [
      async (_tx: unknown, setDeadline: (n: number) => void) => {
        setDeadline(1005)
        return { ok: true, capability: signed }
      },
    ])
    assert.deepEqual(responseDelay, { ok: false, reason: 'denied' })
    assert.equal(transactions, 2)
  } finally {
    await backing.end({ timeout: 1 })
  }
})
