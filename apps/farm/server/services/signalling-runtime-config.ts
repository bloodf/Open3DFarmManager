import { isAbsolute } from 'node:path'
import { z } from 'zod'
import {
  PairingProofOrigin,
  PairingProofAudience,
} from '../../../../packages/farm-protocol/src/pairing-proof.ts'
import { signallingBuildEnabled } from './signalling-build-policy.ts'
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
const Config = z
  .strictObject({
    enabled: z.literal(true),
    origin: PairingProofOrigin.refine((value) => value.startsWith('https://')),
    issuer: z.string().min(1).max(256),
    audience: PairingProofAudience,
    readerDatabaseUrl: databaseUrl,
    proofDatabaseUrl: databaseUrl,
    publicKeyRegistryPath: z.string().min(1).max(2048).refine(isAbsolute),
    tokenTtlSeconds: integer(1, 3600),
    proofTtlMs: integer(1, 8000),
  })
  .refine((value) => {
    const reader = new URL(value.readerDatabaseUrl),
      proof = new URL(value.proofDatabaseUrl)
    return (
      reader.hostname === proof.hostname &&
      (reader.port || '5432') === (proof.port || '5432') &&
      reader.pathname === proof.pathname
    )
  }, 'Signalling pools must use the same dedicated database endpoint')
export type SignallingRuntimeConfig = z.infer<typeof Config>
export function parseSignallingRuntimeConfig(
  input: unknown,
): SignallingRuntimeConfig | null {
  if (!signallingBuildEnabled(input)) return null
  return Config.parse(input)
}
