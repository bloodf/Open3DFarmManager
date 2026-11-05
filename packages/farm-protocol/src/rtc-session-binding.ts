import { z } from 'zod'
import { canonicalize } from './canonical.ts'
import { parseBoundedJson } from './json.ts'
import { base64url, decodeBase64url } from './encoding.ts'
import {
  BrowserDevicePublicKey,
  BrowserDeviceTextId,
  BrowserDeviceUuid,
  validateBrowserDevicePublicKey,
} from './browser-device-proof.ts'
import { PairingPublicKey } from './pairing.ts'
import { PairingProofOrigin, PairingProofAudience } from './pairing-proof.ts'
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const digest = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/)
const fingerprint = z.string().regex(/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/)
export const RtcSessionBinding = z
  .strictObject({
    v: z.literal(1),
    purpose: z.literal('read-only-rtc'),
    transport_id: BrowserDeviceUuid,
    farm_id: BrowserDeviceUuid,
    agent_id: BrowserDeviceUuid,
    account_id: BrowserDeviceTextId,
    key_id: BrowserDeviceUuid,
    browser_public_key: BrowserDevicePublicKey,
    browser_thumbprint: digest,
    connector_public_key_spki: PairingPublicKey,
    connector_fingerprint: z
      .string()
      .regex(/^SHA256:[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/),
    credential_jti: BrowserDeviceUuid,
    origin: PairingProofOrigin,
    audience: PairingProofAudience,
    browser_nonce: digest,
    connector_nonce: digest,
    issued_at: time,
    expires_at: time,
    commands_enabled: z.literal(false),
    offer_sha256: digest,
    answer_sha256: digest,
    browser_dtls: fingerprint,
    connector_dtls: fingerprint,
  })
  .refine(
    (value) =>
      value.expires_at > value.issued_at &&
      value.expires_at - value.issued_at <= 30000,
  )
export type RtcSessionBinding = z.infer<typeof RtcSessionBinding>
const signature = z.string().regex(/^[A-Za-z0-9_-]{85}[AQgw]$/)
export const BrowserRtcProof = z.strictObject({
  v: z.literal(1),
  role: z.literal('browser'),
  binding: RtcSessionBinding,
  signature,
})
export type BrowserRtcProof = z.infer<typeof BrowserRtcProof>
export const ConnectorRtcProof = z.strictObject({
  v: z.literal(1),
  role: z.literal('connector'),
  binding: RtcSessionBinding,
  signature,
})
export type ConnectorRtcProof = z.infer<typeof ConnectorRtcProof>
/** Independent of the 2 KiB RTC application-frame limit. A 32 KiB pending-byte
 * budget can hold at most four maximum-sized proof envelopes.
 * Canonical JSON has a conservative schema-wide bound below 4 KiB: origin alone
 * permits 256 UTF-16 units (at most 1536 JSON-escaped bytes); every other variable
 * string is bounded ASCII. The schema-bound regression test accounts for all fields. */
export const MAX_RTC_PROOF_WIRE_BYTES = 8192
const RtcProof = z.discriminatedUnion('role', [
  BrowserRtcProof,
  ConnectorRtcProof,
])
export type RtcProof = z.infer<typeof RtcProof>
export function encodeRtcProof(input: unknown): string {
  const wire = canonicalize(RtcProof.parse(input))
  if (new TextEncoder().encode(wire).byteLength > MAX_RTC_PROOF_WIRE_BYTES)
    throw new Error('RTC proof byte limit exceeded')
  return wire
}
/** Parse before any signature verification or expensive key import.
 * The v1 proof wire representation is canonical JSON; whitespace/alternate escapes
 * are rejected rather than creating unbounded equivalent wire encodings. */
export function decodeRtcProof(wire: unknown): RtcProof {
  if (
    typeof wire !== 'string' ||
    wire.length > MAX_RTC_PROOF_WIRE_BYTES ||
    new TextEncoder().encode(wire).byteLength > MAX_RTC_PROOF_WIRE_BYTES
  )
    throw new Error('RTC proof byte limit exceeded')
  const proof = RtcProof.parse(
    parseBoundedJson(wire, {
      maxBytes: MAX_RTC_PROOF_WIRE_BYTES,
      maxDepth: 4,
      maxValues: 100,
      maxStringChars: 256,
    }),
  )
  if (canonicalize(proof) !== wire)
    throw new Error('Canonical RTC proof encoding required')
  return proof
}
/** Exact UTF8 bytes, including SDP line endings. No normalization. */
export async function rtcSdpHash(sdp: string): Promise<string> {
  rtcDtlsFingerprint(sdp)
  return base64url(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sdp)),
    ),
  )
}
export type RtcPeerRole = 'browser' | 'connector'
/** Metadata only; the endpoint must additionally compare the actual negotiated DTLS certificate. */
export function rtcDtlsFingerprint(sdp: string): string {
  if (
    typeof sdp !== 'string' ||
    sdp.length > 7000 ||
    !/^v=0\r?\n/.test(sdp) ||
    /^a=candidate:.*\styp\s+relay(?:\s|$)/im.test(sdp)
  )
    throw new Error('Invalid direct SDP')
  const values = new Set<string>()
  for (const line of sdp.split('\n')) {
    if (!/^\s*a\s*=\s*fingerprint\b/i.test(line)) continue
    const match = /^a=fingerprint:sha-256 ([A-Fa-f0-9:]+)\r?$/.exec(line)
    if (!match?.[1]) throw new Error('Unsupported DTLS fingerprint declaration')
    values.add(fingerprint.parse(match[1].toUpperCase()))
  }
  if (values.size !== 1) throw new Error('Unique DTLS fingerprint required')
  return fingerprint.parse(values.values().next().value)
}
export function rtcSessionProofPayload(
  input: unknown,
  role: RtcPeerRole,
): Uint8Array<ArrayBuffer> {
  if (role !== 'browser' && role !== 'connector')
    throw new Error('Invalid peer role')
  return new TextEncoder().encode(
    'Open3DFarmManager/rtc-session-proof/v1\0' +
      role +
      '\0' +
      canonicalize(RtcSessionBinding.parse(input)),
  )
}
export async function rtcBindingFromDescriptions(
  input: unknown,
  role: RtcPeerRole,
  localSdp: string,
  remoteSdp: string,
): Promise<RtcSessionBinding> {
  const parsed = RtcSessionBinding.parse(input),
    local = rtcDtlsFingerprint(localSdp),
    remote = rtcDtlsFingerprint(remoteSdp)
  const offer = role === 'connector' ? localSdp : remoteSdp
  const answer = role === 'browser' ? localSdp : remoteSdp
  if (
    parsed.offer_sha256 !== (await rtcSdpHash(offer)) ||
    parsed.answer_sha256 !== (await rtcSdpHash(answer)) ||
    parsed.browser_dtls !== (role === 'browser' ? local : remote) ||
    parsed.connector_dtls !== (role === 'connector' ? local : remote)
  )
    throw new Error('Local descriptions do not match authenticated binding')
  return parsed
}
/** Portable test/integration primitive. Real ConnectorIdentity must retain its encapsulated KeyObject. */
export async function signRtcSessionProof(
  input: unknown,
  role: RtcPeerRole,
  key: CryptoKey,
): Promise<string> {
  if (
    key.type !== 'private' ||
    key.extractable ||
    (role === 'browser'
      ? key.algorithm.name !== 'ECDSA' ||
        !('namedCurve' in key.algorithm) ||
        key.algorithm.namedCurve !== 'P-256'
      : key.algorithm.name !== 'Ed25519')
  )
    throw new Error('Wrong RTC role key')
  return base64url(
    new Uint8Array(
      await crypto.subtle.sign(
        role === 'browser' ? { name: 'ECDSA', hash: 'SHA-256' } : 'Ed25519',
        key,
        rtcSessionProofPayload(input, role),
      ),
    ),
  )
}
export async function verifyRtcSessionProof(
  input: unknown,
  role: RtcPeerRole,
  signature: unknown,
): Promise<boolean> {
  try {
    const binding = RtcSessionBinding.parse(input)
    if (
      typeof signature !== 'string' ||
      !/^[A-Za-z0-9_-]{85}[AQgw]$/.test(signature)
    )
      return false
    const browser = await validateBrowserDevicePublicKey(
      binding.browser_public_key,
    )
    const connectorDigest = base64url(
      new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          new Uint8Array(
            decodeBase64url(binding.connector_public_key_spki, 44),
          ),
        ),
      ),
    )
    if (
      browser.thumbprint !== binding.browser_thumbprint ||
      'SHA256:' + connectorDigest !== binding.connector_fingerprint
    )
      return false
    const key =
      role === 'browser'
        ? await crypto.subtle.importKey(
            'jwk',
            binding.browser_public_key,
            { name: 'ECDSA', namedCurve: 'P-256' },
            false,
            ['verify'],
          )
        : await crypto.subtle.importKey(
            'spki',
            new Uint8Array(
              decodeBase64url(binding.connector_public_key_spki, 44),
            ),
            'Ed25519',
            false,
            ['verify'],
          )
    return crypto.subtle.verify(
      role === 'browser' ? { name: 'ECDSA', hash: 'SHA-256' } : 'Ed25519',
      key,
      new Uint8Array(decodeBase64url(signature, 64)),
      rtcSessionProofPayload(binding, role),
    )
  } catch {
    return false
  }
}

/** Adapter admission helper: expected binding comes from the trusted server API,
 * never from a received frame. Equality and role checks happen before key import
 * or signature verification. Caller must independently enforce its local deadline
 * before/after this await and compare the actual negotiated DTLS certificate. */
export async function verifyExpectedRtcProof(
  expectedBinding: unknown,
  expectedRole: RtcPeerRole,
  wire: unknown,
): Promise<boolean> {
  try {
    if (expectedRole !== 'browser' && expectedRole !== 'connector') return false
    const expected = RtcSessionBinding.parse(expectedBinding)
    const incoming = decodeRtcProof(wire)
    if (
      incoming.role !== expectedRole ||
      canonicalize(incoming.binding) !== canonicalize(expected)
    )
      return false
    return await verifyRtcSessionProof(
      expected,
      expectedRole,
      incoming.signature,
    )
  } catch {
    return false
  }
}
