import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'

const digest = () => randomBytes(32).toString('base64url')
async function browserFixture() {
  const keys = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const { kty, crv, x, y } = await crypto.subtle.exportKey(
    'jwk',
    keys.publicKey,
  )
  const browser = await validateBrowserDevicePublicKey({ kty, crv, x, y })
  return {
    keys,
    browser,
    challenge: {
      v: 1,
      purpose: 'pause-signalling-admission',
      transport_id: randomUUID(),
      farm_id: randomUUID(),
      agent_id: randomUUID(),
      key_id: randomUUID(),
      assignment_id: randomUUID(),
      account_id: 'account-text-not-uuid',
      thumbprint: browser.thumbprint,
      origin: 'https://farm.example.test',
      audience: 'pause-test',
      nonce: digest(),
      issued_at: 1000,
      expires_at: 9000,
    },
  }
}

import { canonicalize } from '../../packages/farm-protocol/src/canonical.ts'
import { decodeBase64url } from '../../packages/farm-protocol/src/encoding.ts'
import { browserTransportProofPayload } from '../../packages/farm-protocol/src/browser-transport-proof.ts'
import {
  PauseTransportProofChallenge,
  pauseTransportProofPayload,
  signPauseTransportProof,
  verifyPauseTransportProof,
  encodePauseSignallingClientFrame,
  decodePauseSignallingClientFrame,
  encodePauseSignallingServerFrame,
  decodePauseSignallingServerFrame,
  MAX_PAUSE_SIGNALLING_WIRE_BYTES,
} from '../../packages/farm-protocol/src/pause-signalling.ts'
import {
  encodePauseCapability,
  encodePauseAdmissionProof,
} from '../../packages/farm-protocol/src/pause-capability.ts'
import { encodeCommandV2 } from '../../packages/farm-protocol/src/command-v2.ts'
import { encodeControlProof } from '../../packages/farm-protocol/src/control-session-binding.ts'
import {
  encodePauseChannelFrame,
  decodePauseChannelFrame,
  MAX_PAUSE_CHANNEL_WIRE_BYTES,
} from '../../packages/farm-protocol/src/pause-channel.ts'
const sig = 'A'.repeat(86)
const connectorSpki = () =>
  generateKeyPairSync('ed25519')
    .publicKey.export({ type: 'spki', format: 'der' })
    .toString('base64url')

test('pause transport signature binds assignment and cannot cross readonly domain', async () => {
  const { keys, browser, challenge } = await browserFixture()
  const signed = await signPauseTransportProof(challenge, keys.privateKey)
  assert.equal(
    await verifyPauseTransportProof(challenge, browser.publicKey, signed),
    true,
  )
  for (const patch of [
    { assignment_id: randomUUID() },
    { transport_id: randomUUID() },
    { account_id: 'other' },
    { farm_id: randomUUID() },
    { agent_id: randomUUID() },
    { key_id: randomUUID() },
    { thumbprint: digest() },
    { nonce: digest() },
    { origin: 'https://other.example.test' },
    { audience: 'other' },
    { purpose: 'signalling-admission' },
    { v: 2 },
  ])
    assert.equal(
      await verifyPauseTransportProof(
        { ...challenge, ...patch },
        browser.publicKey,
        signed,
      ),
      false,
    )
  const { assignment_id: _, ...withoutAssignment } = challenge
  const readonlyPayload = browserTransportProofPayload({
    ...withoutAssignment,
    purpose: 'signalling-admission',
  })
  assert.equal(
    await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      keys.publicKey,
      new Uint8Array(decodeBase64url(signed, 64)),
      readonlyPayload,
    ),
    false,
  )
  assert.notDeepEqual(pauseTransportProofPayload(challenge), readonlyPayload)
  const extractable = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )
  await assert.rejects(
    signPauseTransportProof(challenge, extractable.privateKey),
  )
})

test('pause signalling is strict, canonical, purpose separated and metadata only', async () => {
  const { challenge } = await browserFixture()
  const begin = {
    v: 1,
    t: 'pause.begin',
    farm_id: challenge.farm_id,
    agent_id: challenge.agent_id,
    key_id: challenge.key_id,
    assignment_id: challenge.assignment_id,
  }
  assert.deepEqual(
    decodePauseSignallingClientFrame(encodePauseSignallingClientFrame(begin)),
    begin,
  )
  const frame = { v: 1, t: 'pause.challenge', challenge }
  assert.deepEqual(
    decodePauseSignallingServerFrame(encodePauseSignallingServerFrame(frame)),
    frame,
  )
  assert.throws(() =>
    encodePauseSignallingClientFrame({ ...begin, t: 'browser.begin' }),
  )
  assert.throws(() =>
    encodePauseSignallingClientFrame({ ...begin, token: 'extra' }),
  )
  assert.throws(() => encodePauseSignallingClientFrame({ ...begin, v: 2 }))
  assert.throws(() =>
    encodePauseSignallingClientFrame({
      v: 1,
      t: 'control.command',
      wire: '{}',
    }),
  )
  assert.throws(() =>
    decodePauseSignallingClientFrame(
      ' ' + encodePauseSignallingClientFrame(begin),
    ),
  )
  assert.throws(() => decodePauseSignallingClientFrame('{"v":1,"v":1}'))
  for (const expires_at of [1000, 999, 9001])
    assert.equal(
      PauseTransportProofChallenge.safeParse({ ...challenge, expires_at })
        .success,
      false,
    )
  assert.throws(() =>
    encodePauseSignallingServerFrame({
      ...frame,
      challenge: { ...challenge, extra: true },
    }),
  )
})

test('fresh Connector context challenge correlates transport and scope, with standalone inbox', async () => {
  const { challenge } = await browserFixture()
  const credential = {
    v: 1,
    purpose: 'signalling',
    agent_id: challenge.agent_id,
    farm_id: challenge.farm_id,
    jti: randomUUID(),
    connection_id: challenge.transport_id,
    public_key_spki: connectorSpki(),
    fingerprint: 'SHA256:' + digest(),
    thumbprint: digest(),
    token_hash: digest(),
    origin: challenge.origin,
    audience: challenge.audience,
    generation: 3,
    nonce: digest(),
    issued_at: 1000,
    expires_at: 9000,
  }
  // Native-generated public material; this codec still does not establish enrollment.
  const context = {
    v: 1,
    t: 'pause.context-challenge',
    transport_id: challenge.transport_id,
    farm_id: challenge.farm_id,
    agent_id: challenge.agent_id,
    assignment_id: challenge.assignment_id,
    challenge: credential,
  }
  assert.deepEqual(
    decodePauseSignallingServerFrame(encodePauseSignallingServerFrame(context)),
    context,
  )
  for (const key of ['transport_id', 'farm_id', 'agent_id'])
    assert.throws(() =>
      encodePauseSignallingServerFrame({ ...context, [key]: randomUUID() }),
    )
  assert.throws(() =>
    encodePauseSignallingServerFrame({
      ...context,
      challenge: { ...credential, purpose: 'telemetry-ingestion' },
    }),
  )
  const inbox = {
    v: 1,
    t: 'pause.connector-begin',
    agent_id: challenge.agent_id,
    farm_id: challenge.farm_id,
    jti: credential.jti,
    token: 'lookup-token-not-authority',
  }
  assert.deepEqual(
    decodePauseSignallingClientFrame(encodePauseSignallingClientFrame(inbox)),
    inbox,
  )
  const ready = {
    v: 1,
    t: 'pause.ready',
    transport_id: challenge.transport_id,
    farm_id: challenge.farm_id,
    agent_id: challenge.agent_id,
    assignment_id: challenge.assignment_id,
    issued_at: 1000,
    expires_at: 31000,
    commands_enabled: false,
  }
  assert.deepEqual(
    decodePauseSignallingServerFrame(encodePauseSignallingServerFrame(ready)),
    ready,
  )
  assert.throws(() =>
    encodePauseSignallingServerFrame({ ...ready, expires_at: 31001 }),
  )
  assert.throws(() =>
    encodePauseSignallingServerFrame({ ...ready, commands_enabled: true }),
  )
})

test('signalling enforces actual escaped output UTF-8 cap without widening inner fields', async () => {
  const { challenge } = await browserFixture()
  const begin = {
    v: 1,
    t: 'pause.connector-begin',
    farm_id: challenge.farm_id,
    agent_id: challenge.agent_id,
    jti: randomUUID(),
    token: 'x'.repeat(8192),
  }
  assert.deepEqual(
    decodePauseSignallingClientFrame(encodePauseSignallingClientFrame(begin)),
    begin,
  )
  assert.throws(() =>
    encodePauseSignallingClientFrame({ ...begin, token: '"'.repeat(8192) }),
  )
  assert.throws(() =>
    encodePauseSignallingClientFrame({ ...begin, token: '界'.repeat(4096) }),
  )
  assert.throws(() =>
    encodePauseSignallingClientFrame({ ...begin, token: 'x'.repeat(8193) }),
  )
  assert.throws(() =>
    decodePauseSignallingClientFrame(
      ' '.repeat(MAX_PAUSE_SIGNALLING_WIRE_BYTES + 1),
    ),
  )
  assert.throws(() =>
    decodePauseSignallingClientFrame(
      canonicalize({ ...begin, token: '界'.repeat(4096) }),
    ),
  )
})

async function capabilityFixture(printerKey: string) {
  const { browser, challenge } = await browserFixture()
  return {
    v: 1,
    purpose: 'pause-authority',
    capability_id: randomUUID(),
    kid: 'test-key',
    issuer: 'test-issuer',
    audience: challenge.audience,
    origin: challenge.origin,
    issued_at: 1000,
    expires_at: 31000,
    account_id: challenge.account_id,
    role: 'operator',
    farm_id: challenge.farm_id,
    agent_id: challenge.agent_id,
    key_id: challenge.key_id,
    assignment_id: challenge.assignment_id,
    transport_id: challenge.transport_id,
    browser_public_key: browser.publicKey,
    browser_thumbprint: browser.thumbprint,
    connector_fingerprint: 'SHA256:' + digest(),
    credential_jti: randomUUID(),
    printer_key: printerKey,
    control_binding_sha256: digest(),
    admission_nonce: digest(),
    actions: ['pause'],
    signature: sig,
  }
}

test('control envelope round-trips maximally escaped valid printer keys and UTF-8', async () => {
  for (const printerKey of [
    '\u0001'.repeat(128),
    '"'.repeat(128),
    '\\'.repeat(128),
    '界'.repeat(128),
    '😀'.repeat(64),
  ]) {
    const cap = await capabilityFixture(printerKey)
    const inner = encodePauseCapability(cap)
    const frame = {
      v: 1,
      t: 'control.capability',
      seq: 0,
      transport_id: cap.transport_id,
      wire: inner,
    }
    const wire = encodePauseChannelFrame(frame)
    assert.ok(Buffer.byteLength(wire) <= 2 * Buffer.byteLength(inner) + 1024)
    assert.ok(Buffer.byteLength(wire) <= MAX_PAUSE_CHANNEL_WIRE_BYTES)
    assert.deepEqual(decodePauseChannelFrame(wire), frame)
    assert.throws(() =>
      encodePauseChannelFrame({ ...frame, transport_id: randomUUID() }),
    )
    assert.throws(() =>
      encodePauseChannelFrame({ ...frame, wire: ' ' + inner }),
    )
  }
})

test('control command and result use exact correlated transport and bounded outcomes', async () => {
  const { challenge } = await browserFixture()
  const command = {
    v: 2,
    purpose: 'printer-pause',
    cmd_id: randomUUID(),
    farm_id: challenge.farm_id,
    agent_id: challenge.agent_id,
    account_id: challenge.account_id,
    key_id: challenge.key_id,
    transport_id: challenge.transport_id,
    capability_id: randomUUID(),
    assignment_id: challenge.assignment_id,
    action: 'pause',
    args: {},
    issued_at: 1000,
    expires_at: 6000,
    nonce: randomBytes(16).toString('base64url'),
    sig,
  }
  const frame = {
    v: 1,
    t: 'control.command',
    transport_id: command.transport_id,
    seq: 255,
    wire: encodeCommandV2(command),
  }
  assert.deepEqual(
    decodePauseChannelFrame(encodePauseChannelFrame(frame)),
    frame,
  )
  assert.throws(() =>
    encodePauseChannelFrame({ ...frame, transport_id: randomUUID() }),
  )
  assert.throws(() => encodePauseChannelFrame({ ...frame, seq: 256 }))
  assert.throws(() => encodePauseChannelFrame({ ...frame, seq: -1 }))
  assert.throws(() =>
    encodePauseChannelFrame({ ...frame, browserProofWire: '{}' }),
  )
  for (const outcome of [
    'rejected',
    'not-sent',
    'applied',
    'outcome-unknown',
  ]) {
    const result = {
      v: 1,
      t: 'control.result',
      transport_id: command.transport_id,
      seq: 1,
      command_id: command.cmd_id,
      outcome,
    }
    assert.deepEqual(
      decodePauseChannelFrame(encodePauseChannelFrame(result)),
      result,
    )
    assert.throws(() =>
      encodePauseChannelFrame({ ...result, reason: 'secret-error' }),
    )
  }
  assert.throws(() =>
    decodePauseChannelFrame(' '.repeat(MAX_PAUSE_CHANNEL_WIRE_BYTES + 1)),
  )
  assert.throws(() =>
    encodePauseChannelFrame({ ...frame, wire: 'x'.repeat(8193) }),
  )
  assert.throws(() => decodePauseChannelFrame('{"v":1,"v":1}'))
})

test('proof and admission messages are individual, strict and transport correlated', async () => {
  const { browser, challenge } = await browserFixture()
  const binding = {
    v: 1,
    purpose: 'pause-rtc',
    transport_id: challenge.transport_id,
    farm_id: challenge.farm_id,
    agent_id: challenge.agent_id,
    account_id: challenge.account_id,
    key_id: challenge.key_id,
    assignment_id: challenge.assignment_id,
    browser_public_key: browser.publicKey,
    browser_thumbprint: browser.thumbprint,
    connector_public_key_spki: connectorSpki(),
    connector_fingerprint: 'SHA256:' + digest(),
    credential_jti: randomUUID(),
    origin: challenge.origin,
    audience: challenge.audience,
    browser_nonce: digest(),
    connector_nonce: digest(),
    issued_at: 1000,
    expires_at: 31000,
    offer_sha256: digest(),
    answer_sha256: digest(),
    browser_dtls: Array(32).fill('AB').join(':'),
    connector_dtls: Array(32).fill('CD').join(':'),
  }
  const proof = encodeControlProof({
    v: 1,
    role: 'browser',
    binding,
    signature: sig,
  })
  const frame = {
    v: 1,
    t: 'control.proof',
    transport_id: challenge.transport_id,
    seq: 0,
    wire: proof,
  }
  assert.deepEqual(
    decodePauseChannelFrame(encodePauseChannelFrame(frame)),
    frame,
  )
  assert.throws(() =>
    encodePauseChannelFrame({ ...frame, transport_id: randomUUID() }),
  )
  assert.throws(() =>
    encodePauseChannelFrame({
      ...frame,
      wire: proof.replace('pause-rtc', 'read-only-rtc'),
    }),
  )
  const nonce = {
    v: 1,
    t: 'control.admission-nonce',
    transport_id: challenge.transport_id,
    seq: 1,
    admission_nonce: digest(),
    issued_at: 1000,
    expires_at: 9000,
  }
  assert.deepEqual(
    decodePauseChannelFrame(encodePauseChannelFrame(nonce)),
    nonce,
  )
  assert.throws(() => encodePauseChannelFrame({ ...nonce, expires_at: 9001 }))
  const ready = {
    v: 1,
    t: 'control.proofs-ready',
    transport_id: challenge.transport_id,
    seq: 2,
  }
  assert.deepEqual(
    decodePauseChannelFrame(encodePauseChannelFrame(ready)),
    ready,
  )
  assert.throws(() =>
    encodePauseChannelFrame({ ...ready, commands_enabled: true }),
  )
})

test('admission proof is separately framed and cannot change its transport or inner limit', async () => {
  const { challenge } = await browserFixture()
  const admission = {
    v: 1,
    purpose: 'pause-admission',
    challenge_id: randomUUID(),
    farm_id: challenge.farm_id,
    agent_id: challenge.agent_id,
    key_id: challenge.key_id,
    assignment_id: challenge.assignment_id,
    transport_id: challenge.transport_id,
    account_id: challenge.account_id,
    browser_thumbprint: challenge.thumbprint,
    origin: challenge.origin,
    audience: challenge.audience,
    control_binding_sha256: digest(),
    admission_nonce: digest(),
    issued_at: 1000,
    expires_at: 9000,
  }
  const wire = encodePauseAdmissionProof({
    challenge: admission,
    signature: sig,
  })
  const frame = {
    v: 1,
    t: 'control.admission-proof',
    transport_id: challenge.transport_id,
    seq: 3,
    wire,
  }
  assert.deepEqual(
    decodePauseChannelFrame(encodePauseChannelFrame(frame)),
    frame,
  )
  assert.throws(() =>
    encodePauseChannelFrame({ ...frame, transport_id: randomUUID() }),
  )
  assert.throws(() =>
    encodePauseChannelFrame({
      ...frame,
      wire: canonicalize({
        challenge: { ...admission, expires_at: 9001 },
        signature: sig,
      }),
    }),
  )
  assert.throws(() =>
    encodePauseChannelFrame({ ...frame, wire: wire + ' '.repeat(8192) }),
  )
  assert.throws(() =>
    encodePauseChannelFrame({
      ...frame,
      capabilityWire: wire,
      browserProofWire: wire,
      connectorProofWire: wire,
    }),
  )
  assert.throws(() => encodePauseSignallingClientFrame(frame))
})
