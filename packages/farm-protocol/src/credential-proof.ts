import { z } from 'zod'
import { PairingPublicKey } from './pairing.ts'
import { PairingProofOrigin } from './pairing-proof.ts'
import { canonicalize } from './canonical.ts'

export const CredentialProofPurpose = z.enum([
  'signalling',
  'telemetry-ingestion',
])
export type CredentialProofPurpose = z.infer<typeof CredentialProofPurpose>
export const CredentialProofId = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase())
const digest = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/)
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const CredentialProofChallenge = z
  .strictObject({
    v: z.literal(1),
    agent_id: CredentialProofId,
    farm_id: CredentialProofId,
    jti: CredentialProofId,
    connection_id: CredentialProofId,
    public_key_spki: PairingPublicKey,
    fingerprint: z
      .string()
      .regex(/^SHA256:[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/),
    thumbprint: digest,
    token_hash: digest,
    origin: PairingProofOrigin,
    audience: z.string().min(1).max(256),
    purpose: CredentialProofPurpose,
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    nonce: digest,
    issued_at: time,
    expires_at: time,
  })
  .refine(
    (value) =>
      value.expires_at > value.issued_at &&
      value.expires_at - value.issued_at <= 60000,
  )
export type CredentialProofChallenge = z.infer<typeof CredentialProofChallenge>
export function credentialProofPayload(input: unknown): Uint8Array {
  return new TextEncoder().encode(
    'Open3DFarmManager/credential-proof/v1\0' +
      canonicalize(CredentialProofChallenge.parse(input)),
  )
}
export const CredentialProofRequest = z.strictObject({
  token: z.string().min(1).max(8192),
  agentId: CredentialProofId,
  farmId: CredentialProofId,
  connectionId: CredentialProofId,
})
export type CredentialProofRequest = z.infer<typeof CredentialProofRequest>
export const CredentialProofCompletion = CredentialProofRequest.extend({
  challenge: CredentialProofChallenge,
  signature: z.string().regex(/^[A-Za-z0-9_-]{85}[AQgw]$/),
})
export type CredentialProofCompletion = z.infer<
  typeof CredentialProofCompletion
>
