import { z } from 'zod'
import { canonicalize } from './canonical.ts'
import { base64url, decodeBase64url } from './encoding.ts'
import { PairingProofOrigin, PairingProofAudience } from './pairing-proof.ts'

export const BROWSER_DEVICE_PROOF_TTL_MS = 60_000
export const BrowserDeviceUuid = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase())
const textId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const coordinate = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/)
export const BrowserDevicePublicKey = z.strictObject({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  x: coordinate,
  y: coordinate,
})
export type BrowserDevicePublicKey = z.infer<typeof BrowserDevicePublicKey>

/** Reject private parameters, alternate encodings and points outside P-256. */
export async function validateBrowserDevicePublicKey(input: unknown): Promise<{
  publicKey: BrowserDevicePublicKey
  thumbprint: string
}> {
  const publicKey = BrowserDevicePublicKey.parse(input)
  decodeBase64url(publicKey.x, 32)
  decodeBase64url(publicKey.y, 32)
  await crypto.subtle.importKey(
    'jwk',
    publicKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  )
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalize(publicKey)),
  )
  return { publicKey, thumbprint: base64url(new Uint8Array(digest)) }
}
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const BrowserDeviceProofChallenge = z
  .strictObject({
    v: z.literal(1),
    purpose: z.enum(['enroll', 'recover']),
    challenge_id: BrowserDeviceUuid,
    farm_id: BrowserDeviceUuid,
    key_id: BrowserDeviceUuid,
    account_id: textId,
    session_id: BrowserDeviceUuid,
    thumbprint: coordinate,
    origin: PairingProofOrigin,
    audience: PairingProofAudience,
    nonce: coordinate,
    issued_at: time,
    expires_at: time,
  })
  .refine(
    (value) =>
      value.expires_at > value.issued_at &&
      value.expires_at - value.issued_at <= BROWSER_DEVICE_PROOF_TTL_MS,
  )
export type BrowserDeviceProofChallenge = z.infer<
  typeof BrowserDeviceProofChallenge
>
export function browserDeviceProofPayload(
  input: unknown,
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    'Open3DFarmManager/browser-device-proof/v1\0' +
      canonicalize(BrowserDeviceProofChallenge.parse(input)),
  )
}
export async function signBrowserDeviceProof(
  challenge: unknown,
  privateKey: CryptoKey,
): Promise<string> {
  if (
    privateKey.type !== 'private' ||
    privateKey.extractable ||
    privateKey.algorithm.name !== 'ECDSA' ||
    !('namedCurve' in privateKey.algorithm) ||
    privateKey.algorithm.namedCurve !== 'P-256'
  )
    throw new Error('Expected a nonextractable P-256 private key')
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    browserDeviceProofPayload(challenge),
  )
  return base64url(new Uint8Array(signature))
}
export async function verifyBrowserDeviceProof(
  challenge: unknown,
  input: unknown,
  signature: string,
): Promise<boolean> {
  try {
    const parsed = BrowserDeviceProofChallenge.parse(challenge)
    const { publicKey, thumbprint } =
      await validateBrowserDevicePublicKey(input)
    if (thumbprint !== parsed.thumbprint) return false
    const key = await crypto.subtle.importKey(
      'jwk',
      publicKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      new Uint8Array(decodeBase64url(signature, 64)),
      browserDeviceProofPayload(parsed),
    )
  } catch {
    return false
  }
}
/** Shape projection only: transportSessionId must come from a future authenticated lease, never a login session reference. */
export function commandBrowserIdentity(input: {
  accountId: string
  transportSessionId: string
}):
  | { ok: true; user_id: string; session_id: string }
  | { ok: false; reason: 'incompatible-identity' } {
  const account = BrowserDeviceUuid.safeParse(input.accountId)
  const session = BrowserDeviceUuid.safeParse(input.transportSessionId)
  return account.success && session.success
    ? { ok: true, user_id: account.data, session_id: session.data }
    : { ok: false, reason: 'incompatible-identity' }
}

export const BrowserDeviceIssueRequest = z.strictObject({
  farm_id: BrowserDeviceUuid,
  public_key: BrowserDevicePublicKey,
  purpose: z.enum(['enroll', 'recover']),
})
export const BrowserDeviceCompletionRequest = z.strictObject({
  challenge_id: BrowserDeviceUuid,
  signature: z.string().max(128),
})
export const BrowserDeviceDecisionRequest = z.strictObject({
  farm_id: BrowserDeviceUuid,
  key_id: BrowserDeviceUuid,
  expected_thumbprint: coordinate,
})
export const BrowserDeviceSnapshotRequest = z.strictObject({
  farm_id: BrowserDeviceUuid,
  key_id: BrowserDeviceUuid,
  proof_session_id: BrowserDeviceUuid,
})
export const BrowserDeviceRole = z.enum([
  'owner',
  'admin',
  'operator',
  'viewer',
])
export const BrowserDeviceTextId = textId
export const BrowserDeviceRecord = z.object({
  key_id: BrowserDeviceUuid,
  farm_id: BrowserDeviceUuid,
  account_id: textId,
  public_key: BrowserDevicePublicKey,
  thumbprint: coordinate,
  status: z.enum(['pending', 'approved', 'revoked']),
  proof_at: time.nullable(),
})
export type BrowserDeviceRecord = z.infer<typeof BrowserDeviceRecord>
