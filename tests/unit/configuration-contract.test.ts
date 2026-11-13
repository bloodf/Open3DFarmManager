import { describe, expect, it } from 'vitest'
import { base64url } from '../../packages/farm-protocol/src/encoding.ts'
import { canonicalize } from '../../packages/farm-protocol/src/canonical.ts'
import {
  controlSdpHash,
  signControlSessionProof,
  controlSessionProofPayload,
} from '../../packages/farm-protocol/src/control-session-binding.ts'
import {
  ConfigurationSessionBinding,
  configurationBindingFromDescriptions,
  configurationBindingHash,
  decodeConfigurationSessionProof,
  encodeConfigurationSessionProof,
  signConfigurationSessionProof,
  validateConfigurationSessionBinding,
  verifyConfigurationSessionPair,
  verifyConfigurationSessionProof,
} from '../../packages/farm-protocol/src/configuration-binding.ts'
import {
  decodeConfigurationAdmissionProof,
  decodeConfigurationCapability,
  encodeConfigurationCapability,
  signConfigurationAdmissionProof,
  signConfigurationCapability,
  verifyConfigurationAdmissionProof,
  verifyConfigurationAuthorityEvidence,
  verifyConfigurationCapability,
} from '../../packages/farm-protocol/src/configuration-capability.ts'
import {
  configurationFrameTargetHash,
  decodeConfigurationRequest,
  decodeConfigurationResponse,
  encodeConfigurationRequest,
  encodeConfigurationResponse,
} from '../../packages/farm-protocol/src/configuration-frames.ts'
import {
  configurationReceiptHash,
  configurationReceiptMatchesContext,
  decodeConfigurationReceipt,
  signConfigurationReceipt,
  verifyConfigurationReceipt,
} from '../../packages/farm-protocol/src/configuration-receipt.ts'
import { configurationTargetHash } from '../../packages/farm-protocol/src/configuration-target.ts'
import { signPauseCapability } from '../../packages/farm-protocol/src/pause-capability.ts'

const NOW = 1_800_000_000_000
const ids = {
  transport: '11111111-1111-4111-8111-111111111111',
  farm: '22222222-2222-4222-8222-222222222222',
  agent: '33333333-3333-4333-8333-333333333333',
  key: '44444444-4444-4444-8444-444444444444',
  jti: '55555555-5555-4555-8555-555555555555',
  capability: '66666666-6666-4666-8666-666666666666',
  challenge: '77777777-7777-4777-8777-777777777777',
  operation: '88888888-8888-4888-8888-888888888888',
  request: '99999999-9999-4999-8999-999999999999',
  receipt: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  assignment: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
}
const nonce = (seed: number) => base64url(new Uint8Array(32).fill(seed))
const dtlsOf = (seed: number) =>
  Array.from({ length: 32 }, () =>
    seed.toString(16).toUpperCase().padStart(2, '0'),
  ).join(':')
const sdp = (seed: number) =>
  `v=0\r\na=fingerprint:sha-256 ${dtlsOf(seed)}\r\na=setup:actpass\r\n`

async function fixture() {
  const browser = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const connector = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const issuer = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const otherIssuer = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const jwk = await crypto.subtle.exportKey('jwk', browser.publicKey)
  const browserPublic = {
    kty: 'EC',
    crv: 'P-256',
    x: jwk.x!,
    y: jwk.y!,
  } as const
  const thumbprint = base64url(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(canonicalize(browserPublic)),
      ),
    ),
  )
  const spkiBytes = new Uint8Array(
    await crypto.subtle.exportKey('spki', connector.publicKey),
  )
  const spki = base64url(spkiBytes)
  const fingerprint =
    'SHA256:' +
    base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', spkiBytes)))
  const offer = sdp(0xaa)
  const answer = sdp(0xbb)
  const binding = {
    v: 1,
    purpose: 'configuration-rtc',
    protocol: 'config-v1',
    transport_id: ids.transport,
    farm_id: ids.farm,
    agent_id: ids.agent,
    account_id: 'account_1',
    key_id: ids.key,
    browser_public_key: browserPublic,
    browser_thumbprint: thumbprint,
    connector_public_key_spki: spki,
    connector_fingerprint: fingerprint,
    credential_jti: ids.jti,
    origin: 'https://farm.example.com',
    audience: 'open3dfarm/connector',
    browser_nonce: nonce(1),
    connector_nonce: nonce(2),
    issued_at: NOW,
    expires_at: NOW + 20_000,
    offer_sha256: await controlSdpHash(offer),
    answer_sha256: await controlSdpHash(answer),
    browser_dtls: dtlsOf(0xbb),
    connector_dtls: dtlsOf(0xaa),
  }
  return {
    browser,
    connector,
    issuer,
    otherIssuer,
    browserPublic,
    thumbprint,
    spki,
    fingerprint,
    binding,
    offer,
    answer,
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>

const target = {
  v: 1,
  protocol: 'config-v1',
  backend: 'kobralink-anycubic',
  model: { family: 'anycubic-kobra-x', provisional: true },
  endpoint: { ipv4: '192.168.1.50', port: 7125 },
  device_id: 'kobra-x-0001',
  bridge: { kind: 'connector-managed' },
} as const

async function capabilityClaims(
  f: Fixture,
  frame: unknown,
  action: 'prepare' | 'commit' | 'status' | 'cancel',
  overrides: Record<string, unknown> = {},
) {
  return {
    v: 1,
    purpose: 'configuration-authority',
    protocol: 'config-v1',
    capability_id: ids.capability,
    kid: 'issuer-1',
    issuer: 'open3dfarm/server',
    audience: f.binding.audience,
    origin: f.binding.origin,
    issued_at: NOW,
    expires_at: NOW + 20_000,
    account_id: f.binding.account_id,
    role: 'owner',
    farm_id: ids.farm,
    agent_id: ids.agent,
    key_id: ids.key,
    transport_id: ids.transport,
    browser_public_key: f.browserPublic,
    browser_thumbprint: f.thumbprint,
    connector_fingerprint: f.fingerprint,
    credential_jti: ids.jti,
    configuration_binding_sha256: await configurationBindingHash(f.binding),
    admission_nonce: nonce(3),
    action,
    operation_id: ids.operation,
    expected_revision: 4,
    target_sha256: await configurationFrameTargetHash(frame),
    ...overrides,
  }
}
async function challengeFor(
  claims: Awaited<ReturnType<typeof capabilityClaims>>,
  overrides: Record<string, unknown> = {},
) {
  return {
    v: 1,
    purpose: 'configuration-admission',
    protocol: 'config-v1',
    challenge_id: ids.challenge,
    capability_id: claims.capability_id,
    farm_id: claims.farm_id,
    agent_id: claims.agent_id,
    key_id: claims.key_id,
    transport_id: claims.transport_id,
    account_id: claims.account_id,
    browser_thumbprint: claims.browser_thumbprint,
    origin: claims.origin,
    audience: claims.audience,
    configuration_binding_sha256: claims.configuration_binding_sha256,
    admission_nonce: claims.admission_nonce,
    action: claims.action,
    operation_id: claims.operation_id,
    expected_revision: claims.expected_revision,
    target_sha256: claims.target_sha256,
    issued_at: NOW,
    expires_at: NOW + 6_000,
    ...overrides,
  }
}
const prepareFrame = {
  v: 1,
  protocol: 'config-v1',
  type: 'prepare',
  request_id: ids.request,
  operation_id: ids.operation,
  expected_revision: 4,
  target,
}
async function evidence(
  f: Fixture,
  opts: {
    frame?: unknown
    claimOverrides?: Record<string, unknown>
    challengeOverrides?: Record<string, unknown>
    binding?: unknown
    issuerKey?: CryptoKey
    now?: number
    action?: 'prepare' | 'commit' | 'status' | 'cancel'
  } = {},
) {
  const frame = opts.frame ?? prepareFrame
  const claims = await capabilityClaims(
    f,
    prepareFrame,
    opts.action ?? 'prepare',
    opts.claimOverrides,
  )
  const capability = await signConfigurationCapability(
    claims,
    f.issuer.privateKey,
  )
  const admission = await signConfigurationAdmissionProof(
    await challengeFor(capability, opts.challengeOverrides),
    f.browser.privateKey,
  )
  return verifyConfigurationAuthorityEvidence({
    frame,
    capability,
    admission,
    binding: opts.binding ?? f.binding,
    issuerKey: opts.issuerKey ?? f.issuer.publicKey,
    now: opts.now ?? NOW + 1_000,
  })
}

describe('configuration session binding', () => {
  it('signs and verifies mutually with real keys, bound to SDP', async () => {
    const f = await fixture()
    const b = await signConfigurationSessionProof(
      f.binding,
      'browser',
      f.browser.privateKey,
    )
    const c = await signConfigurationSessionProof(
      f.binding,
      'connector',
      f.connector.privateKey,
    )
    const browserProof = {
      v: 1,
      role: 'browser',
      binding: f.binding,
      signature: b,
    }
    const connectorProof = {
      v: 1,
      role: 'connector',
      binding: f.binding,
      signature: c,
    }
    const wire = encodeConfigurationSessionProof(browserProof)
    expect(decodeConfigurationSessionProof(wire).role).toBe('browser')
    expect(
      await verifyConfigurationSessionPair(browserProof, connectorProof, {
        role: 'browser',
        localSdp: f.answer,
        remoteSdp: f.offer,
      }),
    ).toMatchObject({ purpose: 'configuration-rtc' })
    // swapped SDP roles / wrong descriptions
    expect(
      await verifyConfigurationSessionPair(browserProof, connectorProof, {
        role: 'browser',
        localSdp: f.offer,
        remoteSdp: f.answer,
      }),
    ).toBeNull()
    await expect(
      configurationBindingFromDescriptions(
        f.binding,
        'connector',
        f.offer,
        sdp(0xcc),
      ),
    ).rejects.toThrow()
    expect(
      canonicalize(ConfigurationSessionBinding.parse(f.binding)),
    ).not.toContain('assignment')
  })

  it('rejects wrong role, purpose, tampered fields and signature swaps', async () => {
    const f = await fixture()
    const b = await signConfigurationSessionProof(
      f.binding,
      'browser',
      f.browser.privateKey,
    )
    const c = await signConfigurationSessionProof(
      f.binding,
      'connector',
      f.connector.privateKey,
    )
    expect(await verifyConfigurationSessionProof(f.binding, 'browser', b)).toBe(
      true,
    )
    expect(
      await verifyConfigurationSessionProof(f.binding, 'connector', b),
    ).toBe(false)
    expect(await verifyConfigurationSessionProof(f.binding, 'browser', c)).toBe(
      false,
    )
    for (const patch of [
      { account_id: 'account_2' },
      { farm_id: ids.assignment },
      { agent_id: ids.assignment },
      { key_id: ids.assignment },
      { credential_jti: ids.assignment },
      { browser_nonce: nonce(9) },
      { connector_nonce: nonce(9) },
      { origin: 'https://evil.example.com' },
      { expires_at: f.binding.expires_at - 1 },
    ])
      expect(
        await verifyConfigurationSessionProof(
          { ...f.binding, ...patch },
          'browser',
          b,
        ),
      ).toBe(false)
    expect(
      await verifyConfigurationSessionProof(
        { ...f.binding, purpose: 'pause-rtc' },
        'browser',
        b,
      ),
    ).toBe(false)
    expect(
      await verifyConfigurationSessionProof(f.binding, 'admin' as never, b),
    ).toBe(false)
    await expect(
      signConfigurationSessionProof(
        f.binding,
        'browser',
        f.connector.privateKey,
      ),
    ).rejects.toThrow()
    await expect(
      signConfigurationSessionProof(
        f.binding,
        'connector',
        f.browser.privateKey,
      ),
    ).rejects.toThrow()
  })

  it('rejects wrong browser key, wrong connector key, invalid keys and long lifetimes', async () => {
    const f = await fixture()
    const g = await fixture()
    // signature from another party's key
    const foreign = await signConfigurationSessionProof(
      { ...g.binding, browser_public_key: g.browserPublic },
      'browser',
      g.browser.privateKey,
    )
    expect(
      await verifyConfigurationSessionProof(f.binding, 'browser', foreign),
    ).toBe(false)
    // thumbprint mismatch with key
    await expect(
      validateConfigurationSessionBinding({
        ...f.binding,
        browser_thumbprint: g.thumbprint,
      }),
    ).rejects.toThrow()
    // fingerprint mismatch with connector key
    await expect(
      validateConfigurationSessionBinding({
        ...f.binding,
        connector_fingerprint: g.fingerprint,
      }),
    ).rejects.toThrow()
    // point not on the curve
    await expect(
      validateConfigurationSessionBinding({
        ...f.binding,
        browser_public_key: { ...f.browserPublic, y: f.browserPublic.x },
      }),
    ).rejects.toThrow()
    expect(() =>
      ConfigurationSessionBinding.parse({
        ...f.binding,
        expires_at: f.binding.issued_at + 30_001,
      }),
    ).toThrow()
    expect(() =>
      ConfigurationSessionBinding.parse({
        ...f.binding,
        assignment_id: ids.assignment,
      }),
    ).toThrow()
    expect(() =>
      ConfigurationSessionBinding.parse({
        ...f.binding,
        connector_nonce: f.binding.browser_nonce,
      }),
    ).toThrow()
  })

  it('refuses pause control proofs as configuration proofs', async () => {
    const f = await fixture()
    const pauseBinding = {
      ...f.binding,
      purpose: 'pause-rtc',
      assignment_id: ids.assignment,
    } as Record<string, unknown>
    delete pauseBinding.protocol
    const pauseSig = await signControlSessionProof(
      pauseBinding,
      'browser',
      f.browser.privateKey,
    )
    expect(
      await verifyConfigurationSessionProof(f.binding, 'browser', pauseSig),
    ).toBe(false)
    // same bytes under the pause domain, signed directly
    const direct = base64url(
      new Uint8Array(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          f.browser.privateKey,
          controlSessionProofPayload(pauseBinding, 'browser'),
        ),
      ),
    )
    expect(
      await verifyConfigurationSessionProof(f.binding, 'browser', direct),
    ).toBe(false)
  })

  it('bounds oversized and deep wire input', async () => {
    const f = await fixture()
    const sig = await signConfigurationSessionProof(
      f.binding,
      'browser',
      f.browser.privateKey,
    )
    const proof = { v: 1, role: 'browser', binding: f.binding, signature: sig }
    const wire = encodeConfigurationSessionProof(proof)
    expect(() => decodeConfigurationSessionProof(wire + ' ')).toThrow()
    expect(() => decodeConfigurationSessionProof(' ' + wire)).toThrow()
    expect(() => decodeConfigurationSessionProof('x'.repeat(9000))).toThrow()
    expect(() => decodeConfigurationSessionProof(42)).toThrow()
    expect(() =>
      decodeConfigurationSessionProof('['.repeat(500) + ']'.repeat(500)),
    ).toThrow()
    expect(() =>
      decodeConfigurationSessionProof(
        wire.replace('"role":"browser"', '"role":"browser","role":"connector"'),
      ),
    ).toThrow()
  })
})

describe('configuration capability and admission', () => {
  it('accepts correct evidence as cryptographic only, with replay key', async () => {
    const f = await fixture()
    const result = await evidence(f)
    expect(result).toMatchObject({ ok: true, evidence: 'cryptographic-only' })
    if (!result.ok) return
    expect(result.replayKey).toEqual({
      capability_id: ids.capability,
      admission_nonce: nonce(3),
      operation_id: ids.operation,
    })
    const wire = encodeConfigurationCapability(result.claims)
    expect(decodeConfigurationCapability(wire)).toEqual(result.claims)
    expect(() => decodeConfigurationCapability(wire + ' ')).toThrow()
  })

  it('allows owner and admin only', async () => {
    const f = await fixture()
    for (const role of ['operator', 'viewer', 'member'])
      await expect(
        signConfigurationCapability(
          await capabilityClaims(f, prepareFrame, 'prepare', { role }),
          f.issuer.privateKey,
        ),
      ).rejects.toThrow()
    expect(
      await evidence(f, { claimOverrides: { role: 'admin' } }),
    ).toMatchObject({ ok: true })
  })

  it('rejects expiry, long lifetimes and bad issuer keys', async () => {
    const f = await fixture()
    expect(await evidence(f, { now: NOW + 20_000 })).toMatchObject({
      ok: false,
      reason: 'capability-expired',
    })
    expect(await evidence(f, { now: NOW - 1 })).toMatchObject({
      ok: false,
      reason: 'capability-expired',
    })
    await expect(
      signConfigurationCapability(
        await capabilityClaims(f, prepareFrame, 'prepare', {
          expires_at: NOW + 30_001,
        }),
        f.issuer.privateKey,
      ),
    ).rejects.toThrow()
    expect(
      await evidence(f, { issuerKey: f.otherIssuer.publicKey }),
    ).toMatchObject({ ok: false, reason: 'capability-signature' })
    // binding window ended while capability is still fresh
    expect(
      await evidence(f, {
        now: f.binding.expires_at + 1,
        claimOverrides: {
          expires_at: f.binding.expires_at + 5000,
          issued_at: f.binding.expires_at - 5000,
        },
        challengeOverrides: {
          issued_at: f.binding.expires_at - 2000,
          expires_at: f.binding.expires_at + 3000,
        },
      }),
    ).toMatchObject({ ok: false, reason: 'binding-expired' })
    // issuer must be a nonextractable Ed25519 private key
    await expect(
      signConfigurationCapability(
        await capabilityClaims(f, prepareFrame, 'prepare'),
        f.browser.privateKey,
      ),
    ).rejects.toThrow()
    expect(await verifyConfigurationCapability({}, f.issuer.publicKey)).toBe(
      false,
    )
    expect(
      await verifyConfigurationCapability(
        await signConfigurationCapability(
          await capabilityClaims(f, prepareFrame, 'prepare'),
          f.issuer.privateKey,
        ),
        f.issuer.privateKey,
      ),
    ).toBe(false)
  })

  it('rejects mismatched account, farm, agent, browser, key and nonce context', async () => {
    const f = await fixture()
    const g = await fixture()
    const cases: Array<[string, Record<string, unknown>]> = [
      ['account', { account_id: 'account_2' }],
      ['farm', { farm_id: ids.assignment }],
      ['agent', { agent_id: ids.assignment }],
      ['key id', { key_id: ids.assignment }],
      ['transport', { transport_id: ids.assignment }],
      ['credential', { credential_jti: ids.assignment }],
      ['origin', { origin: 'https://evil.example.com' }],
      ['audience', { audience: 'open3dfarm/other' }],
      ['connector', { connector_fingerprint: g.fingerprint }],
      ['binding hash', { configuration_binding_sha256: nonce(8) }],
    ]
    for (const [name, patch] of cases)
      expect(await evidence(f, { claimOverrides: patch }), name).toMatchObject({
        ok: false,
        reason: 'context-mismatch',
      })
    // another browser key: capability self-consistent but not the bound key
    expect(
      await evidence(f, {
        claimOverrides: {
          browser_public_key: g.browserPublic,
          browser_thumbprint: g.thumbprint,
        },
      }),
    ).toMatchObject({ ok: false, reason: 'context-mismatch' })
    // admission challenge disagreeing with capability
    for (const patch of [
      { admission_nonce: nonce(9) },
      { account_id: 'account_2' },
      { farm_id: ids.assignment },
      { agent_id: ids.assignment },
      { capability_id: ids.assignment },
      { key_id: ids.assignment },
      { operation_id: ids.assignment },
      { expected_revision: 5 },
      { action: 'commit' },
      { target_sha256: nonce(9) },
    ])
      expect(await evidence(f, { challengeOverrides: patch })).toMatchObject({
        ok: false,
        reason: 'context-mismatch',
      })
  })

  it('rejects admission signed by another browser key or expired', async () => {
    const f = await fixture()
    const g = await fixture()
    const claims = await capabilityClaims(f, prepareFrame, 'prepare')
    const capability = await signConfigurationCapability(
      claims,
      f.issuer.privateKey,
    )
    const forged = await signConfigurationAdmissionProof(
      await challengeFor(capability),
      g.browser.privateKey,
    )
    expect(
      await verifyConfigurationAuthorityEvidence({
        frame: prepareFrame,
        capability,
        admission: forged,
        binding: f.binding,
        issuerKey: f.issuer.publicKey,
        now: NOW + 1000,
      }),
    ).toMatchObject({ ok: false, reason: 'admission-signature' })
    expect(
      await evidence(f, {
        challengeOverrides: { issued_at: NOW, expires_at: NOW + 500 },
        now: NOW + 1000,
      }),
    ).toMatchObject({ ok: false, reason: 'admission-expired' })
    await expect(
      signConfigurationAdmissionProof(
        await challengeFor(capability, { expires_at: NOW + 8001 }),
        f.browser.privateKey,
      ),
    ).rejects.toThrow()
    const good = await signConfigurationAdmissionProof(
      await challengeFor(capability),
      f.browser.privateKey,
    )
    expect(await verifyConfigurationAdmissionProof(good, f.browserPublic)).toBe(
      true,
    )
    expect(await verifyConfigurationAdmissionProof(good, g.browserPublic)).toBe(
      false,
    )
    expect(
      await verifyConfigurationAdmissionProof(
        { ...good, challenge: { ...good.challenge, target_sha256: nonce(9) } },
        f.browserPublic,
      ),
    ).toBe(false)
    expect(() => decodeConfigurationAdmissionProof('{}')).toThrow()
  })

  it('binds action, operation, revision and target hash', async () => {
    const f = await fixture()
    const altered = {
      ...prepareFrame,
      target: { ...target, endpoint: { ipv4: '192.168.1.51', port: 7125 } },
    }
    expect(await evidence(f, { frame: altered })).toMatchObject({
      ok: false,
      reason: 'target-mismatch',
    })
    // identity and bridge swaps change the hash
    for (const patch of [
      { device_id: 'kobra-x-0002' },
      { bridge: { kind: 'existing', bridge_instance_id: 'bridge-1' } },
    ])
      expect(
        await evidence(f, {
          frame: { ...prepareFrame, target: { ...target, ...patch } },
        }),
      ).toMatchObject({ ok: false, reason: 'target-mismatch' })
    expect(
      await evidence(f, { frame: { ...prepareFrame, expected_revision: 5 } }),
    ).toMatchObject({ ok: false, reason: 'revision-mismatch' })
    expect(
      await evidence(f, {
        frame: { ...prepareFrame, operation_id: ids.assignment },
      }),
    ).toMatchObject({ ok: false, reason: 'operation-mismatch' })
    const status = {
      v: 1,
      protocol: 'config-v1',
      type: 'status',
      request_id: ids.request,
      operation_id: ids.operation,
      expected_revision: 4,
      target_sha256: await configurationTargetHash(target),
    }
    // prepare capability cannot authorise status (or any other action)
    expect(await evidence(f, { frame: status })).toMatchObject({
      ok: false,
      reason: 'action-mismatch',
    })
    expect(
      await evidence(f, {
        frame: { ...prepareFrame, type: 'prepare', target: 1 },
      }),
    ).toMatchObject({ ok: false, reason: 'malformed' })
  })

  it('pins commit to the prepared receipt so bridge selection cannot be swapped', async () => {
    const f = await fixture()
    const targetHash = await configurationTargetHash(target)
    const prepared = await signConfigurationReceipt(
      receiptClaims(f, targetHash, 'prepared', { bridge: 'bridge-managed-1' }),
      f.connector.privateKey,
    )
    const swapped = await signConfigurationReceipt(
      receiptClaims(f, targetHash, 'prepared', { bridge: 'bridge-managed-2' }),
      f.connector.privateKey,
    )
    const commit = (receipt: typeof prepared) =>
      configurationReceiptHash(receipt).then((hash) => ({
        v: 1,
        protocol: 'config-v1',
        type: 'commit',
        request_id: ids.request,
        operation_id: ids.operation,
        expected_revision: 4,
        target_sha256: targetHash,
        prepared_receipt_sha256: hash,
      }))
    const claims = await capabilityClaims(f, await commit(prepared), 'commit')
    const capability = await signConfigurationCapability(
      claims,
      f.issuer.privateKey,
    )
    const admission = await signConfigurationAdmissionProof(
      await challengeFor(capability),
      f.browser.privateKey,
    )
    const base = {
      capability,
      admission,
      binding: f.binding,
      issuerKey: f.issuer.publicKey,
      now: NOW + 1000,
    }
    expect(
      await verifyConfigurationAuthorityEvidence({
        ...base,
        frame: await commit(prepared),
      }),
    ).toMatchObject({ ok: true })
    expect(
      await verifyConfigurationAuthorityEvidence({
        ...base,
        frame: await commit(swapped),
      }),
    ).toMatchObject({ ok: false, reason: 'target-mismatch' })
  })

  it('refuses pause capability and admission substitution', async () => {
    const f = await fixture()
    const claims = await capabilityClaims(f, prepareFrame, 'prepare')
    // pause capability signed by the same issuer key with overlapping fields
    const pauseClaims = {
      v: 1,
      purpose: 'pause-authority',
      capability_id: ids.capability,
      kid: 'issuer-1',
      issuer: 'open3dfarm/server',
      audience: claims.audience,
      origin: claims.origin,
      issued_at: NOW,
      expires_at: NOW + 20_000,
      account_id: claims.account_id,
      role: 'owner',
      farm_id: ids.farm,
      agent_id: ids.agent,
      key_id: ids.key,
      assignment_id: ids.assignment,
      transport_id: ids.transport,
      browser_public_key: f.browserPublic,
      browser_thumbprint: f.thumbprint,
      connector_fingerprint: f.fingerprint,
      credential_jti: ids.jti,
      printer_key: 'printer-1',
      control_binding_sha256: claims.configuration_binding_sha256,
      admission_nonce: claims.admission_nonce,
      actions: ['pause'],
    }
    const pause = await signPauseCapability(pauseClaims, f.issuer.privateKey)
    expect(
      await verifyConfigurationCapability(
        { ...claims, signature: pause.signature },
        f.issuer.publicKey,
      ),
    ).toBe(false)
    // config claims signed directly under the pause domain
    const direct = base64url(
      new Uint8Array(
        await crypto.subtle.sign(
          { name: 'Ed25519' },
          f.issuer.privateKey,
          new TextEncoder().encode(
            'Open3DFarmManager/pause-capability/v1\0' + canonicalize(claims),
          ),
        ),
      ),
    )
    expect(
      await verifyConfigurationCapability(
        { ...claims, signature: direct },
        f.issuer.publicKey,
      ),
    ).toBe(false)
    // pause-shaped objects never parse as configuration
    expect(() => decodeConfigurationCapability(canonicalize(pause))).toThrow()
    // admission signed under the pause admission domain
    const challenge = await challengeFor(claims)
    const pauseAdmission = base64url(
      new Uint8Array(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          f.browser.privateKey,
          new TextEncoder().encode(
            'Open3DFarmManager/pause-admission/v1\0' + canonicalize(challenge),
          ),
        ),
      ),
    )
    expect(
      await verifyConfigurationAdmissionProof(
        { challenge, signature: pauseAdmission },
        f.browserPublic,
      ),
    ).toBe(false)
  })
})

function receiptClaims(
  f: Fixture,
  targetHash: string,
  phase:
    | 'prepared'
    | 'local-committed'
    | 'inventory-confirmed'
    | 'recovery-required',
  opts: {
    bridge?: string
    prior?: string
    overrides?: Record<string, unknown>
  } = {},
) {
  const committed =
    phase === 'local-committed' || phase === 'inventory-confirmed'
  return {
    v: 1,
    purpose: 'configuration-receipt',
    protocol: 'config-v1',
    receipt_id: ids.receipt,
    account_id: f.binding.account_id,
    farm_id: ids.farm,
    agent_id: ids.agent,
    connector_fingerprint: f.fingerprint,
    operation_id: ids.operation,
    phase,
    target: {
      target_sha256: targetHash,
      device_id: 'kobra-x-0001',
      bridge_instance_id: opts.bridge ?? 'bridge-managed-1',
    },
    observed: {
      device_id: 'kobra-x-0001',
      model: 'Kobra X',
      firmware: { status: 'unknown' },
      support: 'unqualified',
    },
    expected_revision: 4,
    committed_revision: committed ? 5 : null,
    recovery_reason: phase === 'recovery-required' ? 'commit-incomplete' : null,
    prior_receipt_sha256:
      phase === 'prepared' ? null : (opts.prior ?? nonce(7)),
    issued_at: NOW,
    ...opts.overrides,
  }
}

describe('configuration receipts and frames', () => {
  it('signs, verifies and chains Connector receipts in a separate domain', async () => {
    const f = await fixture()
    const targetHash = await configurationTargetHash(target)
    const prepared = await signConfigurationReceipt(
      receiptClaims(f, targetHash, 'prepared'),
      f.connector.privateKey,
    )
    expect(
      await verifyConfigurationReceipt(prepared, f.connector.publicKey),
    ).toBe(true)
    const wire = canonicalize(prepared)
    expect(decodeConfigurationReceipt(wire)).toEqual(prepared)
    const committed = await signConfigurationReceipt(
      receiptClaims(f, targetHash, 'local-committed', {
        prior: await configurationReceiptHash(prepared),
      }),
      f.connector.privateKey,
    )
    expect(committed.committed_revision).toBe(5)
    expect(
      configurationReceiptMatchesContext(committed, {
        account_id: f.binding.account_id,
        farm_id: ids.farm,
        agent_id: ids.agent,
        operation_id: ids.operation,
        target_sha256: targetHash,
        device_id: 'kobra-x-0001',
        expected_revision: 4,
      }),
    ).toBe(true)
    for (const patch of [
      { account_id: 'account_2' },
      { farm_id: ids.assignment },
      { agent_id: ids.assignment },
      { operation_id: ids.assignment },
      { target_sha256: nonce(9) },
      { device_id: 'kobra-x-0002' },
      { expected_revision: 9 },
    ])
      expect(
        configurationReceiptMatchesContext(committed, {
          account_id: f.binding.account_id,
          farm_id: ids.farm,
          agent_id: ids.agent,
          operation_id: ids.operation,
          target_sha256: targetHash,
          device_id: 'kobra-x-0001',
          expected_revision: 4,
          ...patch,
        }),
      ).toBe(false)
    // altered claims, wrong key, wrong signature domain
    for (const patch of [
      { committed_revision: 6 },
      { phase: 'inventory-confirmed' },
      { account_id: 'account_2' },
      {
        target: { ...committed.target, bridge_instance_id: 'bridge-managed-9' },
      },
    ])
      expect(
        await verifyConfigurationReceipt(
          { ...committed, ...patch },
          f.connector.publicKey,
        ),
      ).toBe(false)
    const g = await fixture()
    expect(
      await verifyConfigurationReceipt(committed, g.connector.publicKey),
    ).toBe(false)
    expect(
      await verifyConfigurationReceipt(committed, f.issuer.publicKey),
    ).toBe(false)
    expect(
      await verifyConfigurationReceipt(committed, f.connector.privateKey),
    ).toBe(false)
    const { signature: _s, ...unsigned } = committed
    const capabilityDomain = base64url(
      new Uint8Array(
        await crypto.subtle.sign(
          { name: 'Ed25519' },
          f.connector.privateKey,
          new TextEncoder().encode(
            'Open3DFarmManager/configuration-capability/config-v1\0' +
              canonicalize(unsigned),
          ),
        ),
      ),
    )
    expect(
      await verifyConfigurationReceipt(
        { ...committed, signature: capabilityDomain },
        f.connector.publicKey,
      ),
    ).toBe(false)
    await expect(
      signConfigurationReceipt(
        receiptClaims(f, targetHash, 'prepared'),
        f.browser.privateKey,
      ),
    ).rejects.toThrow()
  })

  it('keeps receipt states honest', async () => {
    const f = await fixture()
    const targetHash = await configurationTargetHash(target)
    const bad: Array<Record<string, unknown>> = [
      { phase: 'prepared', committed_revision: 5 },
      {
        phase: 'local-committed',
        committed_revision: null,
        prior_receipt_sha256: nonce(7),
      },
      {
        phase: 'local-committed',
        committed_revision: 4,
        prior_receipt_sha256: nonce(7),
      },
      {
        phase: 'recovery-required',
        recovery_reason: null,
        prior_receipt_sha256: nonce(7),
      },
      { phase: 'prepared', recovery_reason: 'rollback-failed' },
      { phase: 'prepared', prior_receipt_sha256: nonce(7) },
      { phase: 'unknown' },
      {
        observed: {
          device_id: 'kobra-x-9999',
          model: null,
          firmware: { status: 'unknown' },
          support: 'unqualified',
        },
      },
      {
        observed: {
          device_id: 'kobra-x-0001',
          model: null,
          firmware: { status: 'unknown' },
          support: 'supported',
        },
      },
      { password: 'secret' },
    ]
    for (const patch of bad)
      await expect(
        signConfigurationReceipt(
          { ...receiptClaims(f, targetHash, 'prepared'), ...patch },
          f.connector.privateKey,
        ),
      ).rejects.toThrow()
    const recovery = await signConfigurationReceipt(
      receiptClaims(f, targetHash, 'recovery-required'),
      f.connector.privateKey,
    )
    expect(recovery.committed_revision).toBeNull()
    const confirmed = await signConfigurationReceipt(
      receiptClaims(f, targetHash, 'inventory-confirmed'),
      f.connector.privateKey,
    )
    expect(confirmed.phase).toBe('inventory-confirmed')
  })

  it('encodes closed canonical request and response frames', async () => {
    const f = await fixture()
    const targetHash = await configurationTargetHash(target)
    const wire = encodeConfigurationRequest(prepareFrame)
    expect(decodeConfigurationRequest(wire)).toEqual(prepareFrame)
    for (const type of ['status', 'cancel'] as const) {
      const frame = {
        v: 1,
        protocol: 'config-v1',
        type,
        request_id: ids.request,
        operation_id: ids.operation,
        expected_revision: 4,
        target_sha256: targetHash,
      }
      expect(
        decodeConfigurationRequest(encodeConfigurationRequest(frame)).type,
      ).toBe(type)
    }
    expect(() =>
      decodeConfigurationRequest(wire.replace(/^\{/, '{ ')),
    ).toThrow()
    expect(() => decodeConfigurationRequest('x'.repeat(17_000))).toThrow()
    expect(() =>
      decodeConfigurationRequest('['.repeat(200) + ']'.repeat(200)),
    ).toThrow()
    // no secret, URL, method or proxy payloads
    for (const extra of [
      { password: 'x' },
      { cookie: 'a=b' },
      { private_key: 'k' },
      { url: 'http://192.168.1.50/' },
      { method: 'POST' },
      { headers: {} },
    ])
      expect(() =>
        encodeConfigurationRequest({ ...prepareFrame, ...extra }),
      ).toThrow()
    expect(() =>
      encodeConfigurationRequest({
        ...prepareFrame,
        target: { ...target, password: 'x' },
      }),
    ).toThrow()
    for (const endpoint of [
      { ipv4: 'printer.local', port: 80 },
      { ipv4: 'http://192.168.1.50', port: 80 },
      { ipv4: '192.168.001.050', port: 80 },
      { ipv4: '256.1.1.1', port: 80 },
      { ipv4: '0.0.0.0', port: 80 },
      { ipv4: '224.0.0.1', port: 80 },
      { ipv4: '10.0.0.1', port: 0 },
      { ipv4: '10.0.0.1', port: 65536 },
    ])
      expect(() =>
        encodeConfigurationRequest({
          ...prepareFrame,
          target: { ...target, endpoint },
        }),
      ).toThrow()
    expect(() =>
      encodeConfigurationRequest({
        ...prepareFrame,
        target: {
          ...target,
          model: { family: 'anycubic-kobra-x', provisional: false },
        },
      }),
    ).toThrow()

    const receipt = await signConfigurationReceipt(
      receiptClaims(f, targetHash, 'prepared'),
      f.connector.privateKey,
    )
    const result = {
      v: 1,
      protocol: 'config-v1',
      type: 'result',
      request_id: ids.request,
      operation_id: ids.operation,
      state: 'prepared',
      receipt,
    }
    expect(
      decodeConfigurationResponse(encodeConfigurationResponse(result)),
    ).toEqual(result)
    // a prepared receipt can never be presented as committed
    expect(() =>
      encodeConfigurationResponse({ ...result, state: 'local-committed' }),
    ).toThrow()
    expect(() =>
      encodeConfigurationResponse({ ...result, operation_id: ids.assignment }),
    ).toThrow()
    const unknown = {
      v: 1,
      protocol: 'config-v1',
      type: 'unknown',
      request_id: ids.request,
      operation_id: ids.operation,
      state: 'unknown',
      reason: 'timeout-after-write',
    }
    expect(
      decodeConfigurationResponse(encodeConfigurationResponse(unknown)),
    ).toEqual(unknown)
    expect(() => encodeConfigurationResponse({ ...unknown, receipt })).toThrow()
    const error = {
      v: 1,
      protocol: 'config-v1',
      type: 'error',
      request_id: null,
      code: 'firmware-unsupported',
    }
    expect(
      decodeConfigurationResponse(encodeConfigurationResponse(error)),
    ).toEqual(error)
    expect(() =>
      encodeConfigurationResponse({ ...error, message: 'free text' }),
    ).toThrow()
    expect(() =>
      encodeConfigurationResponse({ ...error, code: 'anything' }),
    ).toThrow()
  })

  it('represents unknown firmware explicitly and never as supported', async () => {
    const f = await fixture()
    const targetHash = await configurationTargetHash(target)
    const observed = {
      device_id: 'kobra-x-0001',
      model: 'Kobra X',
      firmware: { status: 'observed', version: '1.2.3' },
      support: 'unqualified',
    }
    const receipt = await signConfigurationReceipt(
      receiptClaims(f, targetHash, 'prepared', { overrides: { observed } }),
      f.connector.privateKey,
    )
    expect(receipt.observed.firmware).toEqual({
      status: 'observed',
      version: '1.2.3',
    })
    for (const firmware of [
      { status: 'observed', version: '1.2 3; rm -rf /' },
      { status: 'observed' },
      { status: 'unknown', version: '1' },
      { status: 'supported' },
    ])
      await expect(
        signConfigurationReceipt(
          receiptClaims(f, targetHash, 'prepared', {
            overrides: { observed: { ...observed, firmware } },
          }),
          f.connector.privateKey,
        ),
      ).rejects.toThrow()
  })

  it('hashes targets deterministically and distinctly', async () => {
    const a = await configurationTargetHash(target)
    expect(
      await configurationTargetHash(JSON.parse(JSON.stringify(target))),
    ).toBe(a)
    expect(
      await configurationTargetHash({ ...target, device_id: 'kobra-x-0002' }),
    ).not.toBe(a)
    await expect(
      configurationTargetHash({ ...target, extra: 1 }),
    ).rejects.toThrow()
  })
})
