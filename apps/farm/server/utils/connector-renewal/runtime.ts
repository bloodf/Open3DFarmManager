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
import { databasePhase } from '../database/phase.ts'
import { createLogger } from '@open3dfarmmanager/shared'

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
let closed = false
let retryAfter = 0
const RETRY_MS = 30_000
const log = createLogger('farm-server')

function unavailable() {
  return createError({ status: 503, message: 'Renovação indisponível.' })
}

async function activate(config: z.infer<typeof RenewalRuntimeConfig>) {
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
    if (closed) throw new Error('Renewal runtime closed')
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
    // Closed while activating: undo, never leave an installed handler or a pool.
    if (closed) {
      deactivateCredentialRenewalHttpRuntime()
      throw new Error('Renewal runtime closed')
    }
    pool = sql
  } catch (error) {
    await sql.end({ timeout: 3 })
    throw error
  }
}

/**
 * Activates the renewal handler on first use, only once the database gate has
 * verified the schema (phase 'ready'); an unmanaged database is refused.
 * Disabled → 404; invalid config, unready database, closed runtime or failed
 * activation → 503. A failed activation is retried no sooner than 30 s later.
 */
export async function connectorRenewalHandler(now: () => number = Date.now) {
  const raw: unknown = Reflect.get(useRuntimeConfig(), 'connectorRenewal')
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('enabled' in raw) ||
    raw.enabled !== true
  )
    throw createError({ status: 404, message: 'Renovação indisponível.' })
  const parsed = RenewalRuntimeConfig.safeParse(raw)
  if (!parsed.success || closed || databasePhase() !== 'ready')
    throw unavailable()
  const active = credentialRenewalHttpRuntime()
  if (active) return active
  if (!starting) {
    if (now() < retryAfter) throw unavailable()
    const mine = activate(parsed.data)
    starting = mine
    mine.catch((error: unknown) => {
      if (starting === mine) {
        starting = undefined
        retryAfter = now() + RETRY_MS
      }
      // Fixed message and error class only: no paths, URLs or key material.
      log.error('connector-renewal-activation-failed', {
        errorClass: error instanceof Error ? error.constructor.name : 'unknown',
        retryAfterMs: RETRY_MS,
      })
    })
  }
  try {
    await starting
  } catch {
    throw unavailable()
  }
  const handler = closed ? undefined : credentialRenewalHttpRuntime()
  if (!handler) throw unavailable()
  return handler
}

export async function closeConnectorRenewalRuntime(): Promise<void> {
  closed = true
  await starting?.catch(() => {})
  starting = undefined
  deactivateCredentialRenewalHttpRuntime()
  const sql = pool
  pool = undefined
  await sql?.end({ timeout: 3 })
}
