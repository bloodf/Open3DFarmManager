// Original work, MIT licensed.
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
import { RtcSessionBindingV2 } from './rtc-session-binding.ts'
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const digest = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/)
const fingerprint = z.string().regex(/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/)
const bindingFields = z.strictObject({
  v: z.literal(3),
  purpose: z.literal('camera-rtc'),
  camera_id: BrowserDeviceTextId,
  printer_id: BrowserDeviceTextId,
  video_mid: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  lease_ref: BrowserDeviceTextId,
  assignment_count: z.number().int().min(1).max(16),
  assignment_digest: digest,
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
const validLifetime = (value: { issued_at: number; expires_at: number }) =>
  value.expires_at > value.issued_at &&
  value.expires_at - value.issued_at <= 30000
/** Statement only. No lease, admission, authorization, track or replay evidence. */
export const CameraPurposeStatement = bindingFields.refine(validLifetime)
export type CameraPurposeStatement = z.infer<typeof CameraPurposeStatement>
export const CameraPurposeProof = z.strictObject({
  v: z.literal(3),
  role: z.enum(['browser', 'connector']),
  binding: CameraPurposeStatement,
  signature: z.string().regex(/^[A-Za-z0-9_-]{85}[AQgw]$/),
})
export type CameraPurposeProof = z.infer<typeof CameraPurposeProof>
export const MAX_CAMERA_PROOF_WIRE_BYTES = 8192
export function encodeCameraPurposeProof(input: unknown): string {
  const wire = canonicalize(CameraPurposeProof.parse(input))
  if (new TextEncoder().encode(wire).byteLength > MAX_CAMERA_PROOF_WIRE_BYTES)
    throw new Error('Camera proof byte limit exceeded')
  return wire
}
export function decodeCameraPurposeProof(wire: unknown): CameraPurposeProof {
  if (typeof wire !== 'string' || wire.length > MAX_CAMERA_PROOF_WIRE_BYTES)
    throw new Error('Invalid camera proof frame')
  const proof = CameraPurposeProof.parse(
    parseBoundedJson(wire, {
      maxBytes: MAX_CAMERA_PROOF_WIRE_BYTES,
      maxDepth: 4,
      maxValues: 100,
      maxStringChars: 256,
    }),
  )
  if (encodeCameraPurposeProof(proof) !== wire)
    throw new Error('Canonical camera proof required')
  return proof
}
export function cameraPurposeProofPayload(
  input: unknown,
  role: CameraPurposeProof['role'],
): Uint8Array<ArrayBuffer> {
  if (role !== 'browser' && role !== 'connector')
    throw new Error('Invalid camera proof role')
  return new TextEncoder().encode(
    'Open3DFarmManager/camera-purpose-proof/v1\0' +
      role +
      '\0' +
      canonicalize(CameraPurposeStatement.parse(input)),
  )
}
/** Expected statement, role and existing public key must come from independent
 * caller context. Success proves only this signature over this exact statement.
 * Callers still own enrollment, authority, deadlines, actual tracks and replay. */
export async function verifyExpectedCameraPurposeProof(input: {
  expectedStatement: unknown
  expectedRole: CameraPurposeProof['role']
  expectedPublicKey: unknown
  wire: unknown
}): Promise<CameraPurposeProof | null> {
  try {
    const { expectedRole: role } = input
    if (role !== 'browser' && role !== 'connector') return null
    const expected = CameraPurposeStatement.parse(input.expectedStatement)
    const proof = decodeCameraPurposeProof(input.wire)
    if (
      proof.role !== role ||
      canonicalize(proof.binding) !== canonicalize(expected)
    )
      return null
    const browser = await validateBrowserDevicePublicKey(
      expected.browser_public_key,
    )
    const spki = new Uint8Array(
      decodeBase64url(expected.connector_public_key_spki, 44),
    )
    const connector = await crypto.subtle.importKey(
      'spki',
      spki,
      'Ed25519',
      false,
      ['verify'],
    )
    const fingerprint =
      'SHA256:' +
      base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', spki)))
    if (
      browser.thumbprint !== expected.browser_thumbprint ||
      fingerprint !== expected.connector_fingerprint
    )
      return null
    const expectedKey =
      role === 'browser'
        ? BrowserDevicePublicKey.parse(input.expectedPublicKey)
        : PairingPublicKey.parse(input.expectedPublicKey)
    if (
      canonicalize(expectedKey) !==
      canonicalize(
        role === 'browser'
          ? expected.browser_public_key
          : expected.connector_public_key_spki,
      )
    )
      return null
    const key =
      role === 'browser'
        ? await crypto.subtle.importKey(
            'jwk',
            browser.publicKey,
            { name: 'ECDSA', namedCurve: 'P-256' },
            false,
            ['verify'],
          )
        : connector
    return (await crypto.subtle.verify(
      role === 'browser' ? { name: 'ECDSA', hash: 'SHA-256' } : 'Ed25519',
      key,
      new Uint8Array(decodeBase64url(proof.signature, 64)),
      cameraPurposeProofPayload(expected, role),
    ))
      ? proof
      : null
  } catch {
    return null
  }
}
export type CameraPurposeFields = Readonly<{
  camera_id: string
  printer_id: string
  video_mid: string
  lease_ref: string
}>
/** Derives the only accepted camera statement from an admitted assignment (v2)
 * RTC binding. Transport, identities, assignment set and lifetime are copied. */
export function cameraStatementFromBinding(
  input: unknown,
  fields: CameraPurposeFields,
): CameraPurposeStatement {
  const binding = RtcSessionBindingV2.parse(input)
  return CameraPurposeStatement.parse({
    ...binding,
    v: 3,
    purpose: 'camera-rtc',
    camera_id: fields.camera_id,
    printer_id: fields.printer_id,
    video_mid: fields.video_mid,
    lease_ref: fields.lease_ref,
  })
}
/** Portable signer; the key must be the non-extractable private key of its role. */
export async function signCameraPurposeProof(
  input: unknown,
  role: CameraPurposeProof['role'],
  key: CryptoKey,
): Promise<string> {
  const statement = CameraPurposeStatement.parse(input)
  if (
    key.type !== 'private' ||
    key.extractable ||
    (role === 'browser'
      ? key.algorithm.name !== 'ECDSA' ||
        !('namedCurve' in key.algorithm) ||
        key.algorithm.namedCurve !== 'P-256'
      : key.algorithm.name !== 'Ed25519')
  )
    throw new Error('Wrong camera proof role key')
  const signature = base64url(
    new Uint8Array(
      await crypto.subtle.sign(
        role === 'browser' ? { name: 'ECDSA', hash: 'SHA-256' } : 'Ed25519',
        key,
        cameraPurposeProofPayload(statement, role),
      ),
    ),
  )
  return encodeCameraPurposeProof({ v: 3, role, binding: statement, signature })
}
