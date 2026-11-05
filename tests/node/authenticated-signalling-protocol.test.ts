import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, randomBytes } from 'node:crypto'
import { base64url } from '../../packages/farm-protocol/src/encoding.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import {
  BrowserTransportProofChallenge,
  signBrowserTransportProof,
  verifyBrowserTransportProof,
} from '../../packages/farm-protocol/src/browser-transport-proof.ts'
import {
  BrowserRtcProof,
  ConnectorRtcProof,
  RtcSessionBinding,
  rtcBindingFromDescriptions,
  rtcDtlsFingerprint,
  rtcSdpHash,
  signRtcSessionProof,
  verifyRtcSessionProof,
} from '../../packages/farm-protocol/src/rtc-session-binding.ts'
import { decodeAuthenticatedSignallingFrame } from '../../packages/farm-protocol/src/authenticated-signalling.ts'
const nonce = () => base64url(randomBytes(32))
const sdp = (hex: string) =>
  `v=0\r\na=fingerprint:sha-256 ${Array(32).fill(hex).join(':')}\r\n`
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
  const exported = await crypto.subtle.exportKey('jwk', browser.publicKey)
  const browserKey = await validateBrowserDevicePublicKey({
    kty: exported.kty,
    crv: exported.crv,
    x: exported.x,
    y: exported.y,
  })
  const connectorSpki = base64url(
    new Uint8Array(await crypto.subtle.exportKey('spki', connector.publicKey)),
  )
  const connectorFingerprint =
    'SHA256:' +
    base64url(
      new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          await crypto.subtle.exportKey('spki', connector.publicKey),
        ),
      ),
    )
  const offer = sdp('AB'),
    answer = sdp('CD')
  const binding = RtcSessionBinding.parse({
    v: 1,
    purpose: 'read-only-rtc',
    transport_id: randomUUID(),
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    account_id: 'account_text',
    key_id: randomUUID(),
    browser_public_key: browserKey.publicKey,
    browser_thumbprint: browserKey.thumbprint,
    connector_public_key_spki: connectorSpki,
    connector_fingerprint: connectorFingerprint,
    credential_jti: randomUUID(),
    origin: 'https://farm.example',
    audience: 'farm-test',
    browser_nonce: nonce(),
    connector_nonce: nonce(),
    issued_at: 1000,
    expires_at: 31000,
    commands_enabled: false,
    browser_dtls: rtcDtlsFingerprint(answer),
    connector_dtls: rtcDtlsFingerprint(offer),
    offer_sha256: await rtcSdpHash(offer),
    answer_sha256: await rtcSdpHash(answer),
  })
  return { browser, connector, browserKey, binding, offer, answer }
}
test('real P-256 admission proof binds transport, account, origin and ephemeral challenge', async () => {
  const f = await fixture()
  const challenge = BrowserTransportProofChallenge.parse({
    v: 1,
    purpose: 'signalling-admission',
    transport_id: f.binding.transport_id,
    farm_id: f.binding.farm_id,
    agent_id: f.binding.agent_id,
    key_id: f.binding.key_id,
    account_id: f.binding.account_id,
    thumbprint: f.browserKey.thumbprint,
    origin: f.binding.origin,
    audience: f.binding.audience,
    nonce: nonce(),
    issued_at: 1000,
    expires_at: 9000,
  })
  const signature = await signBrowserTransportProof(
    challenge,
    f.browser.privateKey,
  )
  assert.equal(
    await verifyBrowserTransportProof(
      challenge,
      f.browserKey.publicKey,
      signature,
    ),
    true,
  )
  for (const mutation of [
    { transport_id: randomUUID() },
    { account_id: 'other' },
    { origin: 'https://other.example' },
    { nonce: nonce() },
  ])
    assert.equal(
      await verifyBrowserTransportProof(
        { ...challenge, ...mutation },
        f.browserKey.publicKey,
        signature,
      ),
      false,
    )
  assert.equal(
    BrowserTransportProofChallenge.safeParse({ ...challenge, expires_at: 9001 })
      .success,
    false,
  )
  assert.equal(
    await verifyRtcSessionProof(f.binding, 'browser', signature),
    false,
  )
})
test('role-separated real P-256 and Ed25519 RTC proofs pin identity and exact SDP hashes', async () => {
  const f = await fixture()
  const browserSignature = await signRtcSessionProof(
    f.binding,
    'browser',
    f.browser.privateKey,
  )
  const connectorSignature = await signRtcSessionProof(
    f.binding,
    'connector',
    f.connector.privateKey,
  )
  BrowserRtcProof.parse({
    v: 1,
    role: 'browser',
    binding: f.binding,
    signature: browserSignature,
  })
  ConnectorRtcProof.parse({
    v: 1,
    role: 'connector',
    binding: f.binding,
    signature: connectorSignature,
  })
  assert.equal(
    await verifyRtcSessionProof(f.binding, 'browser', browserSignature),
    true,
  )
  assert.equal(
    await verifyRtcSessionProof(f.binding, 'connector', connectorSignature),
    true,
  )
  assert.equal(
    await verifyRtcSessionProof(f.binding, 'connector', browserSignature),
    false,
  )
  for (const mutation of [
    { transport_id: randomUUID() },
    { credential_jti: randomUUID() },
    { answer_sha256: nonce() },
    { browser_thumbprint: nonce() },
    { connector_fingerprint: 'SHA256:' + nonce() },
  ]) {
    assert.equal(
      await verifyRtcSessionProof(
        { ...f.binding, ...mutation },
        'browser',
        browserSignature,
      ),
      false,
    )
    assert.equal(
      await verifyRtcSessionProof(
        { ...f.binding, ...mutation },
        'connector',
        connectorSignature,
      ),
      false,
    )
  }
  await assert.rejects(
    signRtcSessionProof(f.binding, 'browser', f.connector.privateKey),
  )
  assert.equal(
    RtcSessionBinding.safeParse({ ...f.binding, commands_enabled: true })
      .success,
    false,
  )
  assert.equal(
    RtcSessionBinding.safeParse({ ...f.binding, expires_at: 31001 }).success,
    false,
  )
})
test('both endpoints compare exact descriptions; unchanged certificate cannot hide altered SDP', async () => {
  const f = await fixture()
  assert.deepEqual(
    await rtcBindingFromDescriptions(f.binding, 'connector', f.offer, f.answer),
    f.binding,
  )
  assert.deepEqual(
    await rtcBindingFromDescriptions(f.binding, 'browser', f.answer, f.offer),
    f.binding,
  )
  await assert.rejects(
    rtcBindingFromDescriptions(
      f.binding,
      'connector',
      f.offer,
      f.answer + 'a=sendonly\r\n',
    ),
  )
  await assert.rejects(
    rtcBindingFromDescriptions(
      f.binding,
      'browser',
      f.answer.replaceAll('\r\n', '\n'),
      f.offer,
    ),
  )
  assert.throws(() =>
    rtcDtlsFingerprint(
      f.offer +
        'a=fingerprint:sha-256 ' +
        Array(32).fill('EF').join(':') +
        '\r\n',
    ),
  )
  assert.throws(() =>
    rtcDtlsFingerprint(
      f.offer + 'a=candidate:1 1 udp 1 127.0.0.1 9 typ relay\r\n',
    ),
  )
})
test('every session and media fingerprint declaration must use the same valid SHA-256 pin', async () => {
  const valid = sdp('AB')
  const media = 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n'
  const pin = Array(32).fill('AB').join(':')
  assert.equal(
    rtcDtlsFingerprint(valid + media + `a=fingerprint:sha-256 ${pin}\r\n`),
    pin,
  )
  for (const declaration of [
    `a=fingerprint:sha-384 ${Array(48).fill('AB').join(':')}`,
    `a=fingerprint:sha-1 ${Array(20).fill('AB').join(':')}`,
    'a=fingerprint:sha-256 invalid',
    'a=fingerprint:sha-256 AB:CD',
    'a=fingerprint',
    `a=fingerprint:sha-256 ${pin} trailing`,
    ` a=fingerprint:sha-256 ${pin}`,
    `A=FINGERPRINT:sha-256 ${pin}`,
  ]) {
    const ambiguous = valid + media + declaration + '\r\n'
    assert.throws(() => rtcDtlsFingerprint(ambiguous), declaration)
    await assert.rejects(rtcSdpHash(ambiguous), declaration)
  }
})
test('signalling boundary only admits bounded direct SDP/ICE and control metadata', () => {
  const base = { v: 1, transport_id: randomUUID(), seq: 0 }
  const frame = { ...base, t: 'rtc.offer', p: { sdp: sdp('AB') } }
  assert.deepEqual(
    decodeAuthenticatedSignallingFrame(JSON.stringify(frame)),
    frame,
  )
  for (const bad of [
    { ...base, t: 'command', p: { command: 'print.stop' } },
    { ...base, t: 'rtc.offer', p: { sdp: sdp('AB'), command: 'print.stop' } },
    {
      ...base,
      t: 'rtc.ice',
      p: {
        candidate: 'candidate:1 1 udp 1 127.0.0.1 9 typ relay',
        sdpMid: null,
        sdpMLineIndex: 0,
      },
    },
    {
      ...base,
      t: 'rtc.ice',
      p: {
        candidate: 'candidate:1 1 udp 1 host 9 typ host\r\ncommand',
        sdpMid: null,
        sdpMLineIndex: 0,
      },
    },
    { ...base, seq: 256, t: 'rtc.close', p: { reason: 'closed' } },
  ])
    assert.throws(() => decodeAuthenticatedSignallingFrame(JSON.stringify(bad)))
  assert.throws(() => decodeAuthenticatedSignallingFrame(' '.repeat(8193)))
})

test('maximum legal proof fields fit the explicit canonical wire budget and UTF8 is counted before parsing', async () => {
  const { MAX_RTC_PROOF_WIRE_BYTES, encodeRtcProof, decodeRtcProof } =
    await import('../../packages/farm-protocol/src/rtc-session-binding.ts')
  const f = await fixture()
  const origin = 'https://' + '"'.repeat(248)
  const binding = RtcSessionBinding.parse({
    ...f.binding,
    account_id: 'a'.repeat(128),
    origin,
    audience: 'a'.repeat(128),
    issued_at: Number.MAX_SAFE_INTEGER - 30000,
    expires_at: Number.MAX_SAFE_INTEGER,
  })
  const signature = await signRtcSessionProof(
    binding,
    'connector',
    f.connector.privateKey,
  )
  const proof = { v: 1, role: 'connector', binding, signature }
  const wire = encodeRtcProof(proof)
  assert.ok(
    Buffer.byteLength(wire) > 2048,
    'The synthetic 2 KiB data-frame limit cannot carry all legal proofs',
  )
  assert.ok(Buffer.byteLength(wire) <= MAX_RTC_PROOF_WIRE_BYTES)
  assert.deepEqual(decodeRtcProof(wire), proof)
  assert.equal(
    await verifyRtcSessionProof(binding, 'connector', signature),
    true,
  )
  // Every binding property is included. All regex-constrained strings are ASCII;
  // this deliberately invalid origin overestimates ANY JSON escaping by six bytes per unit.
  const conservative = JSON.stringify({
    ...proof,
    binding: { ...binding, origin: '\0'.repeat(256) },
  })
  assert.deepEqual(
    Object.keys(binding).sort(),
    Object.keys(RtcSessionBinding.shape).sort(),
  )
  assert.ok(Buffer.byteLength(conservative) < 4096)
  assert.equal(MAX_RTC_PROOF_WIRE_BYTES, 8192)
  assert.throws(() => decodeRtcProof(wire + ' '), /Canonical/)
  assert.throws(
    () => decodeRtcProof('"' + 'é'.repeat(4096) + '"'),
    /byte limit/,
  )
  assert.throws(() => decodeRtcProof('é'.repeat(4096) + 'a'), /byte limit/)
  assert.throws(() =>
    decodeRtcProof(
      JSON.stringify({ ...proof, binding: { ...binding, account_id: 'é' } }),
    ),
  )
})
