import { z } from 'zod'
import { canonicalize } from './canonical.ts'
import { base64url, decodeBase64url } from './encoding.ts'
import {
  BrowserDeviceUuid,
  BrowserDeviceTextId,
  validateBrowserDevicePublicKey,
} from './browser-device-proof.ts'
import { PairingProofOrigin, PairingProofAudience } from './pairing-proof.ts'
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const digest = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/)
/** Fresh ephemeral transport proof. Not an enrollment challenge or authorization lease. */
export const BrowserTransportProofChallenge = z
  .strictObject({
    v: z.literal(1),
    purpose: z.literal('signalling-admission'),
    transport_id: BrowserDeviceUuid,
    farm_id: BrowserDeviceUuid,
    agent_id: BrowserDeviceUuid,
    key_id: BrowserDeviceUuid,
    account_id: BrowserDeviceTextId,
    thumbprint: digest,
    origin: PairingProofOrigin,
    audience: PairingProofAudience,
    nonce: digest,
    issued_at: time,
    expires_at: time,
  })
  .refine(
    (value) =>
      value.expires_at > value.issued_at &&
      value.expires_at - value.issued_at <= 8000,
  )
export type BrowserTransportProofChallenge = z.infer<
  typeof BrowserTransportProofChallenge
>
export function browserTransportProofPayload(
  input: unknown,
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    'Open3DFarmManager/browser-transport-proof/v1\0' +
      canonicalize(BrowserTransportProofChallenge.parse(input)),
  )
}
export async function signBrowserTransportProof(
  challenge: unknown,
  key: CryptoKey,
): Promise<string> {
  if (
    key.type !== 'private' ||
    key.extractable ||
    key.algorithm.name !== 'ECDSA' ||
    !('namedCurve' in key.algorithm) ||
    key.algorithm.namedCurve !== 'P-256'
  )
    throw new Error('Nonextractable P-256 browser key required')
  return base64url(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        browserTransportProofPayload(challenge),
      ),
    ),
  )
}
export async function verifyBrowserTransportProof(
  challenge: unknown,
  publicJwk: unknown,
  signature: unknown,
): Promise<boolean> {
  try {
    const parsed = BrowserTransportProofChallenge.parse(challenge)
    if (
      typeof signature !== 'string' ||
      !/^[A-Za-z0-9_-]{85}[AQgw]$/.test(signature)
    )
      return false
    const binding = await validateBrowserDevicePublicKey(publicJwk)
    if (binding.thumbprint !== parsed.thumbprint) return false
    const key = await crypto.subtle.importKey(
      'jwk',
      binding.publicKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
    return crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      new Uint8Array(decodeBase64url(signature, 64)),
      browserTransportProofPayload(parsed),
    )
  } catch {
    return false
  }
}
