import { z } from 'zod'
import { canonicalize } from './canonical.ts'
import { parseBoundedJson } from './json.ts'
import { base64url, decodeBase64url } from './encoding.ts'
import {
  BrowserDeviceUuid,
  BrowserDeviceTextId,
  BrowserDevicePublicKey,
  validateBrowserDevicePublicKey,
} from './browser-device-proof.ts'
import { PairingPublicKey } from './pairing.ts'
import { PairingProofOrigin, PairingProofAudience } from './pairing-proof.ts'

const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const digest = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/)
const dtls = z.string().regex(/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/)
const signature = z.string().regex(/^[A-Za-z0-9_-]{85}[AQgw]$/)
export const MAX_CONTROL_PROOF_WIRE_BYTES = 8192
export const ControlSessionBinding = z
  .strictObject({
    v: z.literal(1),
    purpose: z.literal('pause-rtc'),
    transport_id: BrowserDeviceUuid,
    farm_id: BrowserDeviceUuid,
    agent_id: BrowserDeviceUuid,
    account_id: BrowserDeviceTextId,
    key_id: BrowserDeviceUuid,
    assignment_id: BrowserDeviceUuid,
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
    offer_sha256: digest,
    answer_sha256: digest,
    browser_dtls: dtls,
    connector_dtls: dtls,
  })
  .refine(
    (v) => v.expires_at > v.issued_at && v.expires_at - v.issued_at <= 30000,
  )
export type ControlSessionBinding = z.infer<typeof ControlSessionBinding>
export type ControlPeerRole = 'browser' | 'connector'
export const BrowserControlProof = z.strictObject({
  v: z.literal(1),
  role: z.literal('browser'),
  binding: ControlSessionBinding,
  signature,
})
export type BrowserControlProof = z.infer<typeof BrowserControlProof>
export const ConnectorControlProof = z.strictObject({
  v: z.literal(1),
  role: z.literal('connector'),
  binding: ControlSessionBinding,
  signature,
})
export type ConnectorControlProof = z.infer<typeof ConnectorControlProof>
const ControlProof = z.discriminatedUnion('role', [
  BrowserControlProof,
  ConnectorControlProof,
])
export type ControlProof = z.infer<typeof ControlProof>
function bounded(input: unknown): string {
  const wire = canonicalize(input)
  if (new TextEncoder().encode(wire).byteLength > MAX_CONTROL_PROOF_WIRE_BYTES)
    throw new Error('Control proof byte limit exceeded')
  return wire
}
export function encodeControlProof(input: unknown): string {
  return bounded(ControlProof.parse(input))
}
export function decodeControlProof(wire: unknown): ControlProof {
  if (typeof wire !== 'string' || wire.length > MAX_CONTROL_PROOF_WIRE_BYTES)
    throw new Error('Invalid control proof frame')
  const parsed = ControlProof.parse(
    parseBoundedJson(wire, {
      maxBytes: MAX_CONTROL_PROOF_WIRE_BYTES,
      maxDepth: 4,
      maxValues: 100,
      maxStringChars: 256,
    }),
  )
  if (encodeControlProof(parsed) !== wire)
    throw new Error('Canonical control proof required')
  return parsed
}
async function connectorKey(input: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'spki',
    new Uint8Array(decodeBase64url(PairingPublicKey.parse(input), 44)),
    { name: 'Ed25519' },
    false,
    ['verify'],
  )
}
/** Validates native curve/key material and self-consistency, not enrollment or peer provenance. */
export async function validateControlSessionBinding(
  input: unknown,
): Promise<ControlSessionBinding> {
  const binding = ControlSessionBinding.parse(input)
  bounded(binding)
  const browser = await validateBrowserDevicePublicKey(
    binding.browser_public_key,
  )
  await connectorKey(binding.connector_public_key_spki)
  const fingerprint =
    'SHA256:' +
    base64url(
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
    fingerprint !== binding.connector_fingerprint
  )
    throw new Error('Control key binding mismatch')
  return binding
}
export function controlSessionProofPayload(
  input: unknown,
  role: ControlPeerRole,
): Uint8Array<ArrayBuffer> {
  if (role !== 'browser' && role !== 'connector')
    throw new Error('Invalid control proof role')
  return new TextEncoder().encode(
    'Open3DFarmManager/control-session-proof/v1\0' +
      role +
      '\0' +
      bounded(ControlSessionBinding.parse(input)),
  )
}
export async function controlBindingHash(input: unknown): Promise<string> {
  return base64url(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(bounded(ControlSessionBinding.parse(input))),
      ),
    ),
  )
}
/** Trusted-key cryptographic primitive. Real Connector identities keep their private key encapsulated. */
export async function signControlSessionProof(
  input: unknown,
  role: ControlPeerRole,
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
    throw new Error('Invalid control signing key')
  const binding = await validateControlSessionBinding(input)
  const signature = base64url(
    new Uint8Array(
      await crypto.subtle.sign(
        role === 'browser'
          ? { name: 'ECDSA', hash: 'SHA-256' }
          : { name: 'Ed25519' },
        key,
        controlSessionProofPayload(binding, role),
      ),
    ),
  )
  encodeControlProof({ v: 1, role, binding, signature })
  return signature
}
export async function verifyControlSessionProof(
  input: unknown,
  role: ControlPeerRole,
  sig: string,
): Promise<boolean> {
  try {
    if (role !== 'browser' && role !== 'connector') return false
    signature.parse(sig)
    const binding = await validateControlSessionBinding(input)
    const key =
      role === 'browser'
        ? await crypto.subtle.importKey(
            'jwk',
            binding.browser_public_key,
            { name: 'ECDSA', namedCurve: 'P-256' },
            false,
            ['verify'],
          )
        : await connectorKey(binding.connector_public_key_spki)
    return await crypto.subtle.verify(
      role === 'browser'
        ? { name: 'ECDSA', hash: 'SHA-256' }
        : { name: 'Ed25519' },
      key,
      new Uint8Array(decodeBase64url(sig, 64)),
      controlSessionProofPayload(binding, role),
    )
  } catch {
    return false
  }
}
/** Exact UTF-8 SDP bytes; this metadata never substitutes for actual negotiated certificate checks. */
export async function controlSdpHash(sdp: string): Promise<string> {
  controlDtlsFingerprint(sdp)
  return base64url(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sdp)),
    ),
  )
}
export function controlDtlsFingerprint(sdp: string): string {
  // Reject unpaired surrogates rather than hashing TextEncoder replacement bytes.
  canonicalize(sdp)
  if (
    typeof sdp !== 'string' ||
    sdp.length > 7000 ||
    new TextEncoder().encode(sdp).byteLength > 7000 ||
    !/^v=0\r?\n/.test(sdp) ||
    /^a=candidate:.*\styp\s+relay(?:\s|$)/im.test(sdp)
  )
    throw new Error('Invalid direct control SDP')
  const pins = new Set<string>()
  for (const line of sdp.split('\n')) {
    if (!/^\s*a\s*=\s*fingerprint\b/i.test(line)) continue
    const value = /^a=fingerprint:sha-256 ([A-Fa-f0-9:]+)\r?$/.exec(line)?.[1]
    if (!value) throw new Error('Unsupported control DTLS fingerprint')
    pins.add(dtls.parse(value.toUpperCase()))
  }
  if (pins.size !== 1)
    throw new Error('Unique control DTLS fingerprint required')
  return dtls.parse(pins.values().next().value)
}
export async function controlBindingFromDescriptions(
  input: unknown,
  role: ControlPeerRole,
  localSdp: string,
  remoteSdp: string,
): Promise<ControlSessionBinding> {
  if (role !== 'browser' && role !== 'connector')
    throw new Error('Invalid control peer role')
  const binding = await validateControlSessionBinding(input)
  const local = controlDtlsFingerprint(localSdp),
    remote = controlDtlsFingerprint(remoteSdp)
  const offer = role === 'connector' ? localSdp : remoteSdp,
    answer = role === 'browser' ? localSdp : remoteSdp
  if (
    binding.offer_sha256 !== (await controlSdpHash(offer)) ||
    binding.answer_sha256 !== (await controlSdpHash(answer)) ||
    binding.browser_dtls !== (role === 'browser' ? local : remote) ||
    binding.connector_dtls !== (role === 'connector' ? local : remote)
  )
    throw new Error('Control descriptions do not match binding')
  return binding
}
