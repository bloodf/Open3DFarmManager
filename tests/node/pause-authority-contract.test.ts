import test from 'node:test'
import assert from 'node:assert/strict'
import { createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto'
import { decodeCommand } from '../../packages/farm-protocol/src/command.ts'
import {
  decodeCommandV2,
  encodeCommandV2,
  commandV2Payload,
  signCommandV2,
  verifyCommandV2,
} from '../../packages/farm-protocol/src/command-v2.ts'
import {
  PausePolicy,
  PAUSE_POLICY_HARD_MAXIMUMS,
} from '../../packages/farm-protocol/src/pause-capability.ts'

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
  const { validateBrowserDevicePublicKey } = await import(
    '../../packages/farm-protocol/src/browser-device-proof.ts'
  )
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

test('WebCrypto P-256 command signature verifies in Node and binds exact scoped payload', async () => {
  const { pair, publicKey, command } = await commandFixture()
  const signed = await signCommandV2(command, pair.privateKey)
  const nodeKey = createPublicKey({ key: publicKey, format: 'jwk' })
  assert.equal(
    verify(
      'sha256',
      commandV2Payload(command),
      { key: nodeKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signed.sig, 'base64url'),
    ),
    true,
  )
  assert.equal(await verifyCommandV2(signed, publicKey), true)
  for (const patch of [
    { farm_id: randomUUID() },
    { agent_id: randomUUID() },
    { account_id: 'different' },
    { key_id: randomUUID() },
    { transport_id: randomUUID() },
    { capability_id: randomUUID() },
    { assignment_id: randomUUID() },
    { nonce: randomBytes(16).toString('base64url') },
    { issued_at: 1001 },
  ])
    assert.equal(
      await verifyCommandV2({ ...signed, ...patch }, publicKey),
      false,
    )
  assert.equal(
    await verifyCommandV2(signed, { ...publicKey, d: 'A'.repeat(43) }),
    false,
  )
  assert.equal(
    await verifyCommandV2(signed, {
      ...publicKey,
      x: 'A'.repeat(43),
      y: 'A'.repeat(43),
    }),
    false,
  )
  assert.equal(
    await verifyCommandV2(signed, { ...publicKey, alg: 'ES256' }),
    false,
  )
  const payload = Buffer.from(commandV2Payload(command))
  const expected =
    'Open3DFarmManager/printer-command/v2\0' +
    JSON.stringify({
      account_id: command.account_id,
      action: 'pause',
      agent_id: command.agent_id,
      args: {},
      assignment_id: command.assignment_id,
      capability_id: command.capability_id,
      cmd_id: command.cmd_id,
      expires_at: 6000,
      farm_id: command.farm_id,
      issued_at: 1000,
      key_id: command.key_id,
      nonce: command.nonce,
      purpose: 'printer-pause',
      transport_id: command.transport_id,
      v: 2,
    })
  assert.equal(payload.toString('utf8'), expected)
  assert.equal(
    verify(
      'sha256',
      Buffer.concat([Buffer.from('other-domain\0'), payload]),
      { key: nodeKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signed.sig, 'base64url'),
    ),
    false,
  )
})

test('v2 canonical bounded encoding rejects v1, duplicate keys, extra fields and altered wire', async () => {
  const { pair, command } = await commandFixture()
  const signed = await signCommandV2(command, pair.privateKey)
  const wire = encodeCommandV2(signed)
  assert.deepEqual(decodeCommandV2(wire), signed)
  assert.throws(() => decodeCommand(wire))
  assert.throws(() => decodeCommandV2(' ' + wire))
  assert.throws(() => decodeCommandV2(wire.replace('{', '{"v":2,')))
  assert.throws(() => decodeCommandV2(wire.slice(0, -1) + ',"extra":true}'))
  assert.throws(() => decodeCommandV2(' '.repeat(8193)))
})

test('policy permits lower safe values and rejects zero, overflow and raised limits', () => {
  assert.equal(PausePolicy.safeParse(PAUSE_POLICY_HARD_MAXIMUMS).success, true)
  assert.equal(
    PausePolicy.safeParse({
      capabilityMs: 1,
      admissionMs: 1,
      commandMs: 1,
      freshStateMs: 1,
    }).success,
    true,
  )
  for (const [field, max] of Object.entries(PAUSE_POLICY_HARD_MAXIMUMS))
    for (const value of [
      0,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      max + 1,
    ])
      assert.equal(
        PausePolicy.safeParse({ ...PAUSE_POLICY_HARD_MAXIMUMS, [field]: value })
          .success,
        false,
      )
})

test('local printer assignment is immutable, allowlisted, opaque and terminal when retired', async () => {
  const { createPrinterBindingRegistry, readPrinterBinding } = await import(
    '../../packages/connector/src/control/printer-binding.ts'
  )
  const registry = createPrinterBindingRegistry({
    allowedOrigins: ['http://127.0.0.1:7125', 'http://127.0.0.1:7126'],
  })
  const input = {
    assignment_id: randomUUID(),
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    printer_key: 'impressora-á',
    moonraker_origin: 'http://127.0.0.1:7125',
  }
  const binding = registry.provision(input)
  assert.deepEqual(readPrinterBinding(binding), input)
  assert.equal(Object.isFrozen(readPrinterBinding(binding)), true)
  assert.equal(registry.provision({ ...input }), binding)
  assert.throws(() =>
    registry.provision({ ...input, moonraker_origin: 'http://127.0.0.1:7126' }),
  )
  assert.throws(() => registry.provision({ ...input, printer_key: 'other' }))
  assert.throws(() =>
    registry.provision({
      ...input,
      assignment_id: randomUUID(),
      moonraker_origin: 'http://localhost:7125',
    }),
  )
  assert.throws(() => JSON.stringify(binding))
  registry.retire(binding)
  assert.equal(readPrinterBinding(binding), null)
  assert.throws(() => registry.provision(input))
})

async function authorityFixture() {
  const { pair, publicKey, command } = await commandFixture()
  const { validateBrowserDevicePublicKey } = await import(
    '../../packages/farm-protocol/src/browser-device-proof.ts'
  )
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
  const { controlBindingHash } = await import(
    '../../packages/farm-protocol/src/control-session-binding.ts'
  )
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

test('issuer and browser admission use independent domains and canonical UTF-8 wire', async () => {
  const f = await authorityFixture()
  const cap = await import(
    '../../packages/farm-protocol/src/pause-capability.ts'
  )
  const control = await import(
    '../../packages/farm-protocol/src/control-session-binding.ts'
  )
  const maximal = { ...f.capability, printer_key: '\u0001'.repeat(128) }
  const maximalSigned = await cap.signPauseCapability(
    maximal,
    f.issuer.privateKey,
  )
  assert.ok(cap.encodePauseCapability(maximalSigned).includes('\\u0001'))
  assert.ok(Buffer.byteLength(cap.encodePauseCapability(maximalSigned)) < 8192)
  assert.equal(
    await cap.verifyPauseCapability(maximalSigned, f.issuer.publicKey),
    true,
  )
  const signed = await cap.signPauseCapability(
    f.capability,
    f.issuer.privateKey,
  )
  const proof = await cap.signPauseAdmissionProof(
    f.challenge,
    f.pair.privateKey,
  )
  assert.equal(
    await cap.verifyPauseCapability(signed, f.issuer.publicKey),
    true,
  )
  const other = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  assert.equal(await cap.verifyPauseCapability(signed, other.publicKey), false)
  assert.equal(
    await cap.verifyPauseCapability(
      { ...signed, account_id: 'other' },
      f.issuer.publicKey,
    ),
    false,
  )
  assert.equal(await cap.verifyPauseAdmissionProof(proof, f.publicKey), true)
  const wire = cap.encodePauseCapability(signed)
  assert.deepEqual(cap.decodePauseCapability(wire), signed)
  assert.ok(Buffer.byteLength(wire) > wire.length)
  assert.ok(Buffer.byteLength(wire) <= 8192)
  assert.throws(() => cap.decodePauseCapability(' ' + wire))
  assert.throws(() => cap.decodePauseCapability(wire.replace('{', '{"v":1,')))
  const admissionBytes = Buffer.from(cap.pauseAdmissionPayload(f.challenge))
  assert.ok(
    admissionBytes
      .toString()
      .startsWith('Open3DFarmManager/pause-admission/v1\0'),
  )
  const browserSig = await control.signControlSessionProof(
    f.binding,
    'browser',
    f.pair.privateKey,
  )
  const connectorSig = await control.signControlSessionProof(
    f.binding,
    'connector',
    f.connector.privateKey,
  )
  assert.equal(
    await control.verifyControlSessionProof(f.binding, 'browser', browserSig),
    true,
  )
  assert.equal(
    await control.verifyControlSessionProof(
      f.binding,
      'connector',
      connectorSig,
    ),
    true,
  )
  assert.equal(
    await control.verifyControlSessionProof(
      f.binding,
      'browser',
      proof.signature,
    ),
    false,
  )
  assert.equal(
    await control.verifyControlSessionProof(f.binding, 'connector', browserSig),
    false,
  )
  assert.equal(
    await cap.verifyPauseAdmissionProof(
      { ...proof, signature: browserSig },
      f.publicKey,
    ),
    false,
  )
})

async function verifierFixture(expireOnRead = 0) {
  const f = await authorityFixture()
  const { createPrinterBindingRegistry } = await import(
    '../../packages/connector/src/control/printer-binding.ts'
  )
  const { createPauseCapabilityVerifier } = await import(
    '../../packages/connector/src/auth/pause-capability.ts'
  )
  const controls = await import(
    '../../packages/farm-protocol/src/control-session-binding.ts'
  )
  const caps = await import(
    '../../packages/farm-protocol/src/pause-capability.ts'
  )
  const bindings = createPrinterBindingRegistry({
    allowedOrigins: ['http://127.0.0.1:7125'],
  })
  const printerBinding = bindings.provision({
    assignment_id: f.binding.assignment_id,
    farm_id: f.binding.farm_id,
    agent_id: f.binding.agent_id,
    printer_key: f.capability.printer_key,
    moonraker_origin: 'http://127.0.0.1:7125',
  })
  let wall = 1000,
    mono = 1000,
    generation = 1,
    reads = 0
  const issuers = [
    {
      issuer: f.capability.issuer,
      kid: f.capability.kid,
      publicKey: f.issuer.publicKey,
    },
  ]
  const verifier = createPauseCapabilityVerifier({
    issuers,
    clock: {
      wallNow: () => {
        if (++reads === expireOnRead) {
          wall += 8000
          mono += 8000
        }
        return wall
      },
      monotonicNow: () => mono,
    },
  })
  function begin() {
    return verifier.beginAdmission({
      binding: f.binding,
      printerBinding,
      peerGeneration: 1,
      currentPeerGeneration: () => generation,
    })
  }
  async function wires(nonce: string, capPatch: Record<string, unknown> = {}) {
    const capability = await caps.signPauseCapability(
      { ...f.capability, admission_nonce: nonce, ...capPatch },
      f.issuer.privateKey,
    )
    const challenge = { ...f.challenge, admission_nonce: nonce }
    const admission = await caps.signPauseAdmissionProof(
      challenge,
      f.pair.privateKey,
    )
    const browserSig = await controls.signControlSessionProof(
      f.binding,
      'browser',
      f.pair.privateKey,
    )
    const connectorSig = await controls.signControlSessionProof(
      f.binding,
      'connector',
      f.connector.privateKey,
    )
    return {
      capabilityWire: caps.encodePauseCapability(capability),
      admissionProofWire: caps.encodePauseAdmissionProof(admission),
      browserProofWire: controls.encodeControlProof({
        v: 1,
        role: 'browser',
        binding: f.binding,
        signature: browserSig,
      }),
      connectorProofWire: controls.encodeControlProof({
        v: 1,
        role: 'connector',
        binding: f.binding,
        signature: connectorSig,
      }),
    }
  }
  return {
    f,
    verifier,
    issuers,
    begin,
    wires,
    bindings,
    printerBinding,
    advance: (ms: number) => {
      wall += ms
      mono += ms
    },
    setWall: (n: number) => {
      wall = n
    },
    setMono: (n: number) => {
      mono = n
    },
    setGeneration: (n: number) => {
      generation = n
    },
  }
}

test('verifier accepts once, rejects forged handles and invalidates peer or local assignment', async () => {
  const f = await verifierFixture(),
    attempt = f.begin(),
    wires = await f.wires(attempt.challenge.admissionNonce)
  assert.deepEqual(f.verifier.inspect({}), {
    ok: false,
    reason: 'expired-or-inactive',
  })
  f.issuers.length = 0
  const result = await f.verifier.admit(attempt.token, wires)
  assert.ok(result.ok)
  assert.throws(() => JSON.stringify(result.handle))
  assert.equal(f.verifier.inspect(result.handle).ok, true)
  assert.deepEqual(await f.verifier.admit(attempt.token, wires), {
    ok: false,
    reason: 'invalid-admission',
  })
  f.setGeneration(2)
  assert.deepEqual(f.verifier.inspect(result.handle), {
    ok: false,
    reason: 'expired-or-inactive',
  })
  f.setGeneration(1)
  assert.deepEqual(f.verifier.inspect(result.handle), {
    ok: false,
    reason: 'expired-or-inactive',
  })
  const again = f.begin(),
    accepted = await f.verifier.admit(
      again.token,
      await f.wires(again.challenge.admissionNonce),
    )
  assert.ok(accepted.ok)
  f.bindings.retire(f.printerBinding)
  assert.deepEqual(f.verifier.inspect(accepted.handle), {
    ok: false,
    reason: 'expired-or-inactive',
  })
})

test('verifier rejects altered authority scope, nonce, issuer and expired admission', async () => {
  const f = await verifierFixture()
  for (const patch of [
    { farm_id: randomUUID() },
    { account_id: 'other' },
    { key_id: randomUUID() },
    { assignment_id: randomUUID() },
    { control_binding_sha256: randomBytes(32).toString('base64url') },
    { admission_nonce: randomBytes(32).toString('base64url') },
    { issuer: 'untrusted' },
  ]) {
    const attempt = f.begin(),
      wires = await f.wires(attempt.challenge.admissionNonce, patch)
    const result = await f.verifier.admit(attempt.token, wires)
    assert.deepEqual(result, {
      ok: false,
      reason: patch.issuer ? 'untrusted-issuer' : 'scope-mismatch',
    })
  }
  const expired = f.begin(),
    wires = await f.wires(expired.challenge.admissionNonce)
  f.advance(8000)
  assert.deepEqual(await f.verifier.admit(expired.token, wires), {
    ok: false,
    reason: 'expired-or-inactive',
  })
})

test('wall or monotonic regression poisons authority permanently', async () => {
  const f = await verifierFixture(),
    attempt = f.begin(),
    wires = await f.wires(attempt.challenge.admissionNonce)
  const result = await f.verifier.admit(attempt.token, wires)
  assert.ok(result.ok)
  f.setWall(999)
  assert.deepEqual(f.verifier.inspect(result.handle), {
    ok: false,
    reason: 'expired-or-inactive',
  })
  f.setWall(1000)
  assert.deepEqual(f.verifier.inspect(result.handle), {
    ok: false,
    reason: 'expired-or-inactive',
  })
  assert.throws(() => f.begin())
})

test('admission deadline is rechecked after asynchronous transcript hashing', async () => {
  const f = await verifierFixture(4),
    attempt = f.begin(),
    wires = await f.wires(attempt.challenge.admissionNonce)
  assert.deepEqual(await f.verifier.admit(attempt.token, wires), {
    ok: false,
    reason: 'expired-or-inactive',
  })
  assert.deepEqual(await f.verifier.admit(attempt.token, wires), {
    ok: false,
    reason: 'invalid-admission',
  })
})

test('monotonic regression and exact capability deadline deny permanently', async () => {
  const a = await verifierFixture(),
    first = a.begin(),
    result = await a.verifier.admit(
      first.token,
      await a.wires(first.challenge.admissionNonce),
    )
  assert.ok(result.ok)
  a.setMono(999)
  assert.deepEqual(a.verifier.inspect(result.handle), {
    ok: false,
    reason: 'expired-or-inactive',
  })
  assert.throws(() => a.begin())
  const b = await verifierFixture(),
    second = b.begin(),
    live = await b.verifier.admit(
      second.token,
      await b.wires(second.challenge.admissionNonce),
    )
  assert.ok(live.ok)
  b.advance(29000)
  assert.deepEqual(b.verifier.inspect(live.handle), {
    ok: false,
    reason: 'expired-or-inactive',
  })
})
