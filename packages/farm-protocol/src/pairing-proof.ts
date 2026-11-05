import { z } from 'zod'
import { PairingPublicKey } from './pairing.ts'
import { canonicalize } from './canonical.ts'

export const PAIRING_PROOF_TTL_MS = 60_000
export const PairingProofOrigin = z
  .string()
  .max(256)
  .refine((value) => {
    try {
      const url = new URL(value)
      return (
        url.origin === value &&
        (url.protocol === 'https:' ||
          (url.protocol === 'http:' &&
            ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
      )
    } catch {
      return false
    }
  }, 'Expected a canonical HTTPS origin or loopback HTTP origin')
export const PairingProofAudience = z
  .string()
  .regex(/^[A-Za-z0-9:/._-]{1,128}$/)
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const PairingProofChallenge = z
  .strictObject({
    v: z.literal(1),
    agent_id: z
      .string()
      .uuid()
      .refine((value) => value === value.toLowerCase()),
    public_key_spki: PairingPublicKey,
    fingerprint: z
      .string()
      .regex(/^SHA256:[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/),
    origin: PairingProofOrigin,
    audience: PairingProofAudience,
    nonce: z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/),
    issued_at: timestamp,
    expires_at: timestamp,
  })
  .refine(
    (value) =>
      value.expires_at > value.issued_at &&
      value.expires_at - value.issued_at <= PAIRING_PROOF_TTL_MS,
  )
export type PairingProofChallenge = z.infer<typeof PairingProofChallenge>
export const PairingProofCompletion = z.strictObject({
  device_code: z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/),
  challenge: PairingProofChallenge,
  signature: z.string().regex(/^[A-Za-z0-9_-]{85}[AQgw]$/),
})

/** Distinct from Connector transport proofs and printer commands. */
export function pairingProofPayload(input: unknown): Uint8Array {
  return new TextEncoder().encode(
    'Open3DFarmManager/pairing-proof/v1\0' +
      canonicalize(PairingProofChallenge.parse(input)),
  )
}
