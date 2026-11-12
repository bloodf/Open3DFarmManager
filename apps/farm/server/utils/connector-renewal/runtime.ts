import { isAbsolute } from 'node:path'
import postgres from 'postgres'
import { z } from 'zod'
import { createError, useRuntimeConfig } from 'nuxt/server'
import { PairingProofOrigin } from '../../../../../packages/farm-protocol/src/pairing-proof.ts'
import {
  activateCredentialRenewalHttpRuntime,
  credentialRenewalHttpRuntime,
  deactivateCredentialRenewalHttpRuntime,
} from '../../services/credential-renewal-http-runtime.ts'
import { loadTelemetryVerificationKeys } from '../../services/telemetry-key-registry.ts'
import { loadPairingSigningKey } from '../connector-pairing/runtime.ts'

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
const kid = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)

/**
 * Separate opt-in. issuer, audience, signing key and TTL must equal the pairing
 * issuer configuration, or the store denies every parent (fail closed).
 */
export const RenewalRuntimeConfig = z.strictObject({
  enabled: z.literal(true),
  databaseUrl,
  origin: PairingProofOrigin.refine((value) => value.startsWith('https://')),
  issuer: z.string().min(1).max(256),
  audience: z.string().min(1).max(256),
  proofAudience: z.string().min(1).max(256),
  signingKeyId: kid,
  signingKeyPath: z.string().max(2048).refine(isAbsolute),
  publicKeyRegistryPath: z.string().min(1).max(2048).refine(isAbsolute),
  tokenTtlSeconds: integer(1, 3600),
  proofTtlMs: integer(1, 60000),
  bodyTimeoutMs: integer(1, 60000),
})

let starting: Promise<void> | undefined
let pool: ReturnType<typeof postgres> | undefined

function unavailable() {
  return createError({ status: 503, message: 'Renovação indisponível.' })
}

/**
 * Activates the renewal handler on first use. Runs behind the database gate
 * middleware, so the schema is already verified (or no database is managed).
 * Disabled → 404; invalid config or failed activation → 503 (fail closed).
 */
export async function connectorRenewalHandler() {
  const raw: unknown = Reflect.get(useRuntimeConfig(), 'connectorRenewal')
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('enabled' in raw) ||
    raw.enabled !== true
  )
    throw createError({ status: 404, message: 'Renovação indisponível.' })
  const parsed = RenewalRuntimeConfig.safeParse(raw)
  if (!parsed.success) throw unavailable()
  const active = credentialRenewalHttpRuntime()
  if (active) return active
  starting ??= (async () => {
    const config = parsed.data
    const sql = postgres(config.databaseUrl, {
      max: 3,
      connect_timeout: 3,
      idle_timeout: 20,
      connection: { statement_timeout: 2000, lock_timeout: 1000 },
    })
    try {
      const [privateKey, publicKeys] = await Promise.all([
        loadPairingSigningKey(config.signingKeyPath),
        loadTelemetryVerificationKeys(config.publicKeyRegistryPath),
      ])
      // The issued child must stay verifiable by every acceptance path.
      if (!publicKeys.has(config.signingKeyId))
        throw new Error('Signing key is not in the public registry')
      await activateCredentialRenewalHttpRuntime({
        sql,
        bodyTimeoutMs: config.bodyTimeoutMs,
        config: {
          issuer: config.issuer,
          audience: config.audience,
          origin: config.origin,
          proofAudience: config.proofAudience,
          ttlSeconds: config.tokenTtlSeconds,
          kid: config.signingKeyId,
          publicKeys,
          privateKeys: new Map([[config.signingKeyId, privateKey]]),
          proofTtlMs: config.proofTtlMs,
        },
      })
      pool = sql
    } catch (error) {
      await sql.end({ timeout: 3 })
      throw error
    }
  })()
  try {
    await starting
  } catch {
    // Retry on a later request; nothing was installed.
    starting = undefined
    throw unavailable()
  }
  const handler = credentialRenewalHttpRuntime()
  if (!handler) throw unavailable()
  return handler
}

export async function closeConnectorRenewalRuntime(): Promise<void> {
  await starting?.catch(() => {})
  starting = undefined
  deactivateCredentialRenewalHttpRuntime()
  const sql = pool
  pool = undefined
  await sql?.end({ timeout: 3 })
}
