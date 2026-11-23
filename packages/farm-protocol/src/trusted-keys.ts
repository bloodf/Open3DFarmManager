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
import { PairingProofAudience } from './pairing-proof.ts'

/**
 * Versioned, issuer-signed set of the keys one farm's Connector may trust:
 * the farm's issuer public keys and its approved browser device keys. It is
 * pushed over the authenticated credential inbox and carries no command
 * authority. Keys of other farms never belong in it: `farm_id` is signed and
 * the Connector must pin its own farm.
 */
export const MAX_TRUSTED_ISSUER_KEYS = 8
export const MAX_TRUSTED_BROWSER_KEYS = 64
export const MAX_TRUSTED_KEY_SET_WIRE_BYTES = 32768
/** A change (approval, revocation, rotation) is re-sent within this interval. */
export const TRUSTED_KEY_CONFIRMATION_INTERVAL_MS = 5000

const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const digest = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/)
const signature = z.string().regex(/^[A-Za-z0-9_-]{85}[AQgw]$/)
const kid = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/)

export const TrustedIssuerKey = z.strictObject({
  issuer: PairingProofAudience,
  kid,
  /** Ed25519 SubjectPublicKeyInfo, base64url (44 bytes). */
  public_key_spki: z.string().regex(/^[A-Za-z0-9_-]{59}$/),
})
export type TrustedIssuerKey = z.infer<typeof TrustedIssuerKey>
export const TrustedBrowserKey = z.strictObject({
  key_id: BrowserDeviceUuid,
  account_id: BrowserDeviceTextId,
  thumbprint: digest,
  public_key: BrowserDevicePublicKey,
})
export type TrustedBrowserKey = z.infer<typeof TrustedBrowserKey>

const strictlyAscending = (values: readonly string[]) =>
  values.every((value, index) => index === 0 || values[index - 1]! < value)
const fields = {
  v: z.literal(1),
  purpose: z.literal('trusted-key-set'),
  farm_id: BrowserDeviceUuid,
  /** Strictly increases per farm across restarts (see the publisher). */
  version: time,
  issued_at: time,
  /** Signer; must name one of `issuer_keys`. */
  issuer: PairingProofAudience,
  kid,
  /** Sorted by kid, unique: a canonical order keeps the signed bytes stable. */
  issuer_keys: z
    .array(TrustedIssuerKey)
    .min(1)
    .max(MAX_TRUSTED_ISSUER_KEYS)
    .refine((keys) => strictlyAscending(keys.map((key) => key.kid))),
  /** Sorted by key_id, unique; may be empty. */
  browser_keys: z
    .array(TrustedBrowserKey)
    .max(MAX_TRUSTED_BROWSER_KEYS)
    .refine((keys) => strictlyAscending(keys.map((key) => key.key_id))),
}
const signerListed = (value: {
  issuer: string
  kid: string
  issuer_keys: TrustedIssuerKey[]
}) =>
  value.issuer_keys.some(
    (key) => key.kid === value.kid && key.issuer === value.issuer,
  )
const uniqueThumbprints = (value: { browser_keys: TrustedBrowserKey[] }) =>
  new Set(
    value.browser_keys.map((key) => `${key.account_id}\0${key.thumbprint}`),
  ).size === value.browser_keys.length
export const TrustedKeySetV1 = z
  .strictObject(fields)
  .refine(signerListed)
  .refine(uniqueThumbprints)
export type TrustedKeySetV1 = z.infer<typeof TrustedKeySetV1>
export const SignedTrustedKeySetV1 = z
  .strictObject({ ...fields, signature })
  .refine(signerListed)
  .refine(uniqueThumbprints)
export type SignedTrustedKeySetV1 = z.infer<typeof SignedTrustedKeySetV1>
/** The frame as sent over the inbox socket. */
export const TrustedKeySetFrame = z.strictObject({
  v: z.literal(1),
  t: z.literal('trusted-keys.set'),
  key_set: SignedTrustedKeySetV1,
})
export type TrustedKeySetFrame = z.infer<typeof TrustedKeySetFrame>

function bounded(value: unknown): string {
  const wire = canonicalize(value)
  if (
    new TextEncoder().encode(wire).byteLength > MAX_TRUSTED_KEY_SET_WIRE_BYTES
  )
    throw new Error('Trusted key set byte limit exceeded')
  return wire
}
export function encodeTrustedKeySetFrame(input: unknown): string {
  return bounded(TrustedKeySetFrame.parse(input))
}
export function decodeTrustedKeySetFrame(wire: unknown): TrustedKeySetFrame {
  if (typeof wire !== 'string' || wire.length > MAX_TRUSTED_KEY_SET_WIRE_BYTES)
    throw new Error('Invalid trusted key set frame')
  const parsed = TrustedKeySetFrame.parse(
    parseBoundedJson(wire, {
      maxBytes: MAX_TRUSTED_KEY_SET_WIRE_BYTES,
      maxDepth: 6,
      maxValues: 1024,
      maxStringChars: 256,
    }),
  )
  if (encodeTrustedKeySetFrame(parsed) !== wire)
    throw new Error('Canonical trusted key set required')
  return parsed
}
export function trustedKeySetPayload(input: unknown): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    'Open3DFarmManager/trusted-key-set/v1\0' +
      bounded(TrustedKeySetV1.parse(input)),
  )
}
async function validateSet(input: unknown): Promise<TrustedKeySetV1> {
  const parsed = TrustedKeySetV1.parse(input)
  for (const key of parsed.browser_keys) {
    const binding = await validateBrowserDevicePublicKey(key.public_key)
    if (binding.thumbprint !== key.thumbprint)
      throw new Error('Trusted browser key thumbprint mismatch')
  }
  return parsed
}
/** Trusted nonextractable issuer key only; deciding the content is the caller's job. */
export async function signTrustedKeySet(
  input: unknown,
  key: CryptoKey,
): Promise<SignedTrustedKeySetV1> {
  if (
    key.type !== 'private' ||
    key.extractable ||
    key.algorithm.name !== 'Ed25519'
  )
    throw new Error('Trusted nonextractable Ed25519 issuer key required')
  const claims = await validateSet(input)
  const sig = base64url(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: 'Ed25519' },
        key,
        trustedKeySetPayload(claims),
      ),
    ),
  )
  const signed = SignedTrustedKeySetV1.parse({ ...claims, signature: sig })
  encodeTrustedKeySetFrame({ v: 1, t: 'trusted-keys.set', key_set: signed })
  return signed
}
/** Explicit pinned key only: no embedded key, algorithm choice or fallback. */
export async function verifyTrustedKeySet(
  input: unknown,
  key: CryptoKey,
): Promise<boolean> {
  try {
    if (key.type !== 'public' || key.algorithm.name !== 'Ed25519') return false
    const parsed = SignedTrustedKeySetV1.parse(input)
    const { signature: sig, ...unsigned } = parsed
    const claims = await validateSet(unsigned)
    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      new Uint8Array(decodeBase64url(sig, 64)),
      trustedKeySetPayload(claims),
    )
  } catch {
    return false
  }
}
