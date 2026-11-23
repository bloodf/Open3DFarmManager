import { z } from 'zod'
import { ExtendedControlAction, controlRoleAllowed } from './control-actions.ts'
import { canonicalize } from './canonical.ts'
import { parseBoundedJson } from './json.ts'
import { base64url, decodeBase64url } from './encoding.ts'
import {
  BrowserDeviceUuid,
  BrowserDeviceTextId,
  BrowserDevicePublicKey,
  validateBrowserDevicePublicKey,
} from './browser-device-proof.ts'
import { PairingProofOrigin, PairingProofAudience } from './pairing-proof.ts'

export const PAUSE_POLICY_HARD_MAXIMUMS = Object.freeze({
  capabilityMs: 30000,
  admissionMs: 8000,
  commandMs: 5000,
  freshStateMs: 2000,
})
export const PausePolicy = z.strictObject({
  capabilityMs: z
    .number()
    .int()
    .positive()
    .max(PAUSE_POLICY_HARD_MAXIMUMS.capabilityMs),
  admissionMs: z
    .number()
    .int()
    .positive()
    .max(PAUSE_POLICY_HARD_MAXIMUMS.admissionMs),
  commandMs: z
    .number()
    .int()
    .positive()
    .max(PAUSE_POLICY_HARD_MAXIMUMS.commandMs),
  freshStateMs: z
    .number()
    .int()
    .positive()
    .max(PAUSE_POLICY_HARD_MAXIMUMS.freshStateMs),
})
export type PausePolicy = z.infer<typeof PausePolicy>
export const MAX_PAUSE_CAPABILITY_WIRE_BYTES = 8192
export const MAX_PAUSE_ADMISSION_WIRE_BYTES = 8192
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const digest = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/)
const signature = z.string().regex(/^[A-Za-z0-9_-]{85}[AQgw]$/)
const fields = {
  v: z.literal(1),
  purpose: z.literal('pause-authority'),
  capability_id: BrowserDeviceUuid,
  kid: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  issuer: PairingProofAudience,
  audience: PairingProofAudience,
  origin: PairingProofOrigin,
  issued_at: time,
  expires_at: time,
  account_id: BrowserDeviceTextId,
  role: z.enum(['owner', 'admin', 'operator']),
  farm_id: BrowserDeviceUuid,
  agent_id: BrowserDeviceUuid,
  key_id: BrowserDeviceUuid,
  assignment_id: BrowserDeviceUuid,
  transport_id: BrowserDeviceUuid,
  browser_public_key: BrowserDevicePublicKey,
  browser_thumbprint: digest,
  connector_fingerprint: z
    .string()
    .regex(/^SHA256:[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/),
  credential_jti: BrowserDeviceUuid,
  printer_key: z
    .string()
    .min(1)
    .max(128)
    .refine((value) => {
      try {
        canonicalize(value)
        return !value.includes('\0')
      } catch {
        return false
      }
    }),
  control_binding_sha256: digest,
  admission_nonce: digest,
  actions: z
    .array(ExtendedControlAction)
    .min(1)
    .max(ExtendedControlAction.options.length)
    .refine((actions) => new Set(actions).size === actions.length),
}
const lifetime = (value: { issued_at: number; expires_at: number }) =>
  value.expires_at > value.issued_at &&
  value.expires_at - value.issued_at <= PAUSE_POLICY_HARD_MAXIMUMS.capabilityMs
const validRoles = (value: {
  role: string
  actions: ExtendedControlAction[]
}) => value.actions.every((action) => controlRoleAllowed(value.role, action))
export const PauseCapabilityV1 = z
  .strictObject(fields)
  .refine(lifetime)
  .refine(validRoles)
export type PauseCapabilityV1 = z.infer<typeof PauseCapabilityV1>
export const SignedPauseCapabilityV1 = z
  .strictObject({ ...fields, signature })
  .refine(lifetime)
  .refine(validRoles)
export type SignedPauseCapabilityV1 = z.infer<typeof SignedPauseCapabilityV1>
const receivedCapability = z
  .strictObject({
    ...fields,
    actions: z
      .array(z.string().min(1).max(256))
      .min(1)
      .max(100)
      .refine((actions) => new Set(actions).size === actions.length),
    signature,
  })
  .refine(lifetime)
  .refine(({ role, actions }) =>
    actions.every((action) => {
      const known = ExtendedControlAction.safeParse(action)
      return !known.success || controlRoleAllowed(role, known.data)
    }),
  )
function bounded(input: unknown, max: number): string {
  const wire = canonicalize(input)
  if (new TextEncoder().encode(wire).byteLength > max)
    throw new Error('Pause authority byte limit exceeded')
  return wire
}
export function encodePauseCapability(input: unknown): string {
  return bounded(
    SignedPauseCapabilityV1.parse(input),
    MAX_PAUSE_CAPABILITY_WIRE_BYTES,
  )
}
export function decodePauseCapability(
  wire: unknown,
): z.infer<typeof receivedCapability> {
  if (typeof wire !== 'string' || wire.length > MAX_PAUSE_CAPABILITY_WIRE_BYTES)
    throw new Error('Invalid pause capability frame')
  const parsed = receivedCapability.parse(
    parseBoundedJson(wire, {
      maxBytes: MAX_PAUSE_CAPABILITY_WIRE_BYTES,
      maxDepth: 4,
      maxValues: 100,
      maxStringChars: 256,
    }),
  )
  if (bounded(parsed, MAX_PAUSE_CAPABILITY_WIRE_BYTES) !== wire)
    throw new Error('Canonical pause capability required')
  return parsed
}
export function pauseCapabilityPayload(
  input: unknown,
): Uint8Array<ArrayBuffer> {
  return capabilityPayload(PauseCapabilityV1.parse(input))
}
function capabilityPayload(claims: unknown): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    'Open3DFarmManager/pause-capability/v1\0' +
      bounded(claims, MAX_PAUSE_CAPABILITY_WIRE_BYTES),
  )
}
async function validateCapability(input: unknown): Promise<PauseCapabilityV1> {
  const parsed = PauseCapabilityV1.parse(input)
  await validateCapabilityKey(parsed)
  return parsed
}
async function validateCapabilityKey(
  parsed: Pick<PauseCapabilityV1, 'browser_public_key' | 'browser_thumbprint'>,
): Promise<void> {
  const binding = await validateBrowserDevicePublicKey(
    parsed.browser_public_key,
  )
  if (binding.thumbprint !== parsed.browser_thumbprint)
    throw new Error('Pause capability key mismatch')
}
/** Trusted issuer key primitive only; issuance still requires current transactional authority. */
export async function signPauseCapability(
  input: unknown,
  key: CryptoKey,
): Promise<SignedPauseCapabilityV1> {
  if (
    key.type !== 'private' ||
    key.extractable ||
    key.algorithm.name !== 'Ed25519'
  )
    throw new Error('Trusted nonextractable Ed25519 issuer key required')
  const claims = await validateCapability(input)
  const sig = base64url(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: 'Ed25519' },
        key,
        pauseCapabilityPayload(claims),
      ),
    ),
  )
  const signed = SignedPauseCapabilityV1.parse({ ...claims, signature: sig })
  encodePauseCapability(signed)
  return signed
}
/** Explicit trusted key only. No embedded issuer JWK, algorithm selection or bearer authentication. */
export async function verifyPauseCapability(
  input: unknown,
  key: CryptoKey,
): Promise<boolean> {
  try {
    if (key.type !== 'public' || key.algorithm.name !== 'Ed25519') return false
    const parsed = receivedCapability.parse(input),
      { signature: sig, ...unsigned } = parsed
    bounded(parsed, MAX_PAUSE_CAPABILITY_WIRE_BYTES)
    await validateCapabilityKey(unsigned)
    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      new Uint8Array(decodeBase64url(sig, 64)),
      capabilityPayload(unsigned),
    )
  } catch {
    return false
  }
}
export const PauseAdmissionChallenge = z
  .strictObject({
    v: z.literal(1),
    purpose: z.literal('pause-admission'),
    challenge_id: BrowserDeviceUuid,
    farm_id: BrowserDeviceUuid,
    agent_id: BrowserDeviceUuid,
    key_id: BrowserDeviceUuid,
    assignment_id: BrowserDeviceUuid,
    transport_id: BrowserDeviceUuid,
    account_id: BrowserDeviceTextId,
    browser_thumbprint: digest,
    origin: PairingProofOrigin,
    audience: PairingProofAudience,
    control_binding_sha256: digest,
    admission_nonce: digest,
    issued_at: time,
    expires_at: time,
  })
  .refine(
    (value) =>
      value.expires_at > value.issued_at &&
      value.expires_at - value.issued_at <=
        PAUSE_POLICY_HARD_MAXIMUMS.admissionMs,
  )
export type PauseAdmissionChallenge = z.infer<typeof PauseAdmissionChallenge>
export const PauseAdmissionProof = z.strictObject({
  challenge: PauseAdmissionChallenge,
  signature,
})
export type PauseAdmissionProof = z.infer<typeof PauseAdmissionProof>
export function encodePauseAdmissionProof(input: unknown): string {
  return bounded(
    PauseAdmissionProof.parse(input),
    MAX_PAUSE_ADMISSION_WIRE_BYTES,
  )
}
export function decodePauseAdmissionProof(wire: unknown): PauseAdmissionProof {
  if (typeof wire !== 'string' || wire.length > MAX_PAUSE_ADMISSION_WIRE_BYTES)
    throw new Error('Invalid pause admission proof')
  const parsed = PauseAdmissionProof.parse(
    parseBoundedJson(wire, {
      maxBytes: MAX_PAUSE_ADMISSION_WIRE_BYTES,
      maxDepth: 3,
      maxValues: 64,
      maxStringChars: 256,
    }),
  )
  if (encodePauseAdmissionProof(parsed) !== wire)
    throw new Error('Canonical pause admission proof required')
  return parsed
}
export function pauseAdmissionPayload(input: unknown): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    'Open3DFarmManager/pause-admission/v1\0' +
      bounded(
        PauseAdmissionChallenge.parse(input),
        MAX_PAUSE_ADMISSION_WIRE_BYTES,
      ),
  )
}
export async function signPauseAdmissionProof(
  input: unknown,
  key: CryptoKey,
): Promise<PauseAdmissionProof> {
  if (
    key.type !== 'private' ||
    key.extractable ||
    key.algorithm.name !== 'ECDSA' ||
    !('namedCurve' in key.algorithm) ||
    key.algorithm.namedCurve !== 'P-256'
  )
    throw new Error('Nonextractable P-256 private key required')
  const challenge = PauseAdmissionChallenge.parse(input)
  const sig = base64url(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        pauseAdmissionPayload(challenge),
      ),
    ),
  )
  const proof = PauseAdmissionProof.parse({ challenge, signature: sig })
  encodePauseAdmissionProof(proof)
  return proof
}
export async function verifyPauseAdmissionProof(
  input: unknown,
  publicKey: unknown,
): Promise<boolean> {
  try {
    const proof = PauseAdmissionProof.parse(input)
    encodePauseAdmissionProof(proof)
    const binding = await validateBrowserDevicePublicKey(publicKey)
    if (binding.thumbprint !== proof.challenge.browser_thumbprint) return false
    const key = await crypto.subtle.importKey(
      'jwk',
      binding.publicKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      new Uint8Array(decodeBase64url(proof.signature, 64)),
      pauseAdmissionPayload(proof.challenge),
    )
  } catch {
    return false
  }
}
