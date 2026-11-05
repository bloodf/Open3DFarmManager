import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { PairingProofOrigin } from '../../../../packages/farm-protocol/src/pairing-proof.ts'

const databaseUrl = z
  .string()
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
  })
const integer = (min: number, max: number) =>
  z
    .union([
      z.number(),
      z
        .string()
        .regex(/^[0-9]+$/)
        .transform(Number),
    ])
    .pipe(z.number().int().min(min).max(max))
const TelemetryEnabledConfig = z.strictObject({
  enabled: z.literal(true),
  databaseUrl,
  origin: PairingProofOrigin.refine((value) => value.startsWith('https://')),
  issuer: z.string().min(1).max(256),
  audience: z.string().min(1).max(256),
  publicKeyRegistryPath: z.string().min(1).max(2048).refine(isAbsolute),
  tokenTtlSeconds: integer(1, 3600),
  proofTtlMs: integer(1, 60000),
  bodyTimeoutMs: integer(1, 60000),
})
export type TelemetryEnabledConfig = z.infer<typeof TelemetryEnabledConfig>
export type TelemetryConfigResult =
  | { kind: 'disabled' }
  | { kind: 'invalid' }
  | { kind: 'enabled'; config: TelemetryEnabledConfig }

/** No implicit defaults for credentials, trust, lifetimes or activation. */
export function parseTelemetryRuntimeConfig(
  input: unknown,
): TelemetryConfigResult {
  if (
    !input ||
    typeof input !== 'object' ||
    !('enabled' in input) ||
    input.enabled !== true
  )
    return { kind: 'disabled' }
  const parsed = TelemetryEnabledConfig.safeParse(input)
  return parsed.success
    ? { kind: 'enabled', config: parsed.data }
    : { kind: 'invalid' }
}
