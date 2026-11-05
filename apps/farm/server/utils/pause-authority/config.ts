import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { PairingProofAudience } from '../../../../../packages/farm-protocol/src/pairing-proof.ts'
import { PauseCapabilityV1 } from '../../../../../packages/farm-protocol/src/pause-capability.ts'

const Config = z.strictObject({
  enabled: z.literal(true),
  databaseUrl: z
    .string()
    .min(1)
    .max(2048)
    .refine((value) => {
      try {
        const url = new URL(value)
        return (
          ['postgres:', 'postgresql:'].includes(url.protocol) &&
          !!url.hostname &&
          !!url.username &&
          !!url.password &&
          url.pathname.length > 1 &&
          !url.hash
        )
      } catch {
        return false
      }
    }),
  issuerKeyPath: z
    .string()
    .min(1)
    .max(2048)
    .refine((value) => isAbsolute(value) && !value.includes('\0')),
  issuerPublicKeySpki: z.string().regex(/^[A-Za-z0-9_-]{59}$/),
  issuer: PairingProofAudience,
  kid: PauseCapabilityV1.shape.kid,
  audience: PairingProofAudience,
  credentialIssuer: z.string().min(1).max(256),
  credentialAudience: z.string().min(1).max(256),
})
export type PauseAuthorityRuntimeConfig = z.infer<typeof Config>

/** Disabled configuration must not cause filesystem, crypto or database activity. */
export function parsePauseAuthorityRuntimeConfig(
  input: unknown,
): PauseAuthorityRuntimeConfig | null {
  if (
    !input ||
    typeof input !== 'object' ||
    !('enabled' in input) ||
    input.enabled !== true
  )
    return null
  return Object.freeze(Config.parse(input))
}
