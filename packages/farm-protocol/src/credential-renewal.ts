import { z } from 'zod'
import { canonicalize } from './canonical.ts'
import { CredentialProofId } from './credential-proof.ts'
import { PairingPublicKey } from './pairing.ts'
import { PairingProofOrigin } from './pairing-proof.ts'

const digest = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/)
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const RenewalIdentity = z.discriminatedUnion('kind', [
  z
    .strictObject({
      kind: z.literal('root'),
      rootJti: CredentialProofId,
      jti: CredentialProofId,
      agentId: CredentialProofId,
    })
    .refine((x) => x.jti === x.rootJti),
  z
    .strictObject({
      kind: z.literal('successor'),
      rootJti: CredentialProofId,
      jti: CredentialProofId,
      agentId: CredentialProofId,
    })
    .refine((x) => x.jti !== x.rootJti),
])
export type RenewalIdentity = z.infer<typeof RenewalIdentity>
export const RenewalIntent = z.strictObject({
  v: z.literal(1),
  identity: RenewalIdentity,
  farmId: CredentialProofId,
  origin: PairingProofOrigin,
  audience: z.string().min(1).max(256),
})
export const RenewalRequest = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('issue'),
    identity: RenewalIdentity,
    farmId: CredentialProofId,
    token: z.string().min(1).max(8192),
  }),
  z.strictObject({
    mode: z.literal('readback'),
    intent: RenewalIntent,
    identitySignature: z.string().regex(/^[A-Za-z0-9_-]{85}[AQgw]$/),
  }),
])
export type RenewalRequest = z.infer<typeof RenewalRequest>
export const RenewalReservation = z
  .strictObject({
    childJti: CredentialProofId,
    ordinal: z.number().int().positive().max(2147483647),
    kid: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    issuer: z.string().min(1).max(256),
    audience: z.string().min(1).max(256),
    issuedAt: time,
    expiresAt: time,
    tokenHash: digest,
    codec: z.literal(1),
  })
  .refine(
    (x) =>
      x.expiresAt > x.issuedAt &&
      x.expiresAt - x.issuedAt <= 3600 &&
      x.expiresAt <= 8640000000000,
  )
export type RenewalReservation = z.infer<typeof RenewalReservation>
export const RenewalChallenge = z
  .strictObject({
    v: z.literal(1),
    mode: z.enum(['issue', 'readback']),
    identity: RenewalIdentity,
    farmId: CredentialProofId,
    origin: PairingProofOrigin,
    audience: z.string().min(1).max(256),
    publicKeySpki: PairingPublicKey,
    fingerprint: z
      .string()
      .regex(/^SHA256:[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/),
    thumbprint: digest,
    reservation: RenewalReservation,
    nonce: digest,
    attempt: time.refine((x) => x > 0),
    issuedAt: time,
    expiresAt: time,
  })
  .refine((x) => x.expiresAt > x.issuedAt && x.expiresAt - x.issuedAt <= 60000)
export type RenewalChallenge = z.infer<typeof RenewalChallenge>
export const RenewalCompletion = z.strictObject({
  request: RenewalRequest,
  challenge: RenewalChallenge,
  signature: z.string().regex(/^[A-Za-z0-9_-]{85}[AQgw]$/),
})
export type RenewalCompletion = z.infer<typeof RenewalCompletion>
export function renewalIntentPayload(value: unknown): Uint8Array {
  return new TextEncoder().encode(
    'Open3DFarmManager/credential-renewal-readback-intent/v1\0' +
      canonicalize(RenewalIntent.parse(value)),
  )
}
export function renewalProofPayload(value: unknown): Uint8Array {
  return new TextEncoder().encode(
    'Open3DFarmManager/credential-renewal/v1\0' +
      canonicalize(RenewalChallenge.parse(value)),
  )
}
export const RenewalRecoveryReason = z.enum([
  'readback-required',
  'reservation-expired',
  'signing-context-unavailable',
  'result-mismatch',
  'completion-failed',
])
export type RenewalDecision =
  | { kind: 'challenge'; challenge: RenewalChallenge }
  | {
      kind: 'credential'
      identity: RenewalIdentity
      childJti: string
      token: string
      expiresAt: number
    }
  | {
      kind: 'denied' | 'expired' | 'busy' | 'unavailable'
    }
  | { kind: 'recovery-required'; reason: z.infer<typeof RenewalRecoveryReason> }
