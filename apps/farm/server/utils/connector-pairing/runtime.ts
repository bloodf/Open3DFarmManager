import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { importPKCS8 } from 'jose'
import postgres from 'postgres'
import { z } from 'zod'
import { createError, useRuntimeConfig } from 'nuxt/server'
import { PostgresPairing } from '../../storage/postgres-pairing.ts'
import { PostgresPairingProof } from '../../storage/postgres-pairing-proof.ts'
import { PostgresConnectorRevocation } from '../../storage/postgres-connector-revocation.ts'
import { configuredAuthOrigin } from '../auth/boundary.ts'
import { PairingProofAudience } from '../../../../../packages/farm-protocol/src/pairing-proof.ts'
import type { ConnectorCredentialIssuerConfig } from '../connector-credentials.ts'

const databaseUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value)
      return (
        ['postgres:', 'postgresql:'].includes(url.protocol) &&
        !!url.username &&
        !!url.password &&
        url.pathname.length > 1
      )
    } catch {
      return false
    }
  })
export const PairingRuntimeConfig = z.strictObject({
  enabled: z.literal(true),
  origin: z.string().transform(configuredAuthOrigin),
  databaseUrl,
  proofDatabaseUrl: databaseUrl,
  revocationDatabaseUrl: databaseUrl,
  audience: PairingProofAudience,
  issuer: z.string().min(1).max(256),
  signingKeyId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  signingKeyPath: z.string().max(2048).refine(isAbsolute),
  tokenTtlSeconds: z.coerce.number().int().min(1).max(3600),
})
export interface PairingRuntime {
  origin: string
  pairing: PostgresPairing
  proof: PostgresPairingProof
  revocation: PostgresConnectorRevocation
  issuer: ConnectorCredentialIssuerConfig
}
let instance: Promise<PairingRuntime> | undefined
const pools: ReturnType<typeof postgres>[] = []
export function parsePairingConfiguration(raw: unknown) {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('enabled' in raw) ||
    raw.enabled !== true
  )
    throw createError({ status: 404, message: 'Pareamento indisponível.' })
  try {
    return PairingRuntimeConfig.parse(raw)
  } catch {
    throw createError({ status: 503, message: 'Pareamento indisponível.' })
  }
}
export function pairingConfiguredOrigin(): string {
  return parsePairingConfiguration(useRuntimeConfig().connectorPairing).origin
}
export async function loadPairingSigningKey(path: string): Promise<CryptoKey> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  let pem: string
  try {
    const stat = await file.stat()
    if (
      !stat.isFile() ||
      stat.size > 8192 ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.()
    )
      throw new Error('Invalid signing key file')
    const bytes = Buffer.alloc(8193)
    const read = await file.read(bytes, 0, bytes.length, 0)
    if (read.bytesRead > 8192) throw new Error('Invalid signing key file')
    pem = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(0, read.bytesRead),
    )
  } finally {
    await file.close()
  }
  const key = await importPKCS8(pem, 'EdDSA', { extractable: false })
  if (key.type !== 'private' || key.algorithm.name !== 'Ed25519')
    throw new Error('Invalid signing key')
  return key
}
async function validateRuntimeRole(
  sql: ReturnType<typeof postgres>,
  expectedRole: string,
): Promise<void> {
  const rows = await sql<{ allowed: boolean }[]>`
    SELECT
      pg_has_role(current_user, ${expectedRole}, 'USAGE')
      AND NOT EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'USAGE') AND (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls))
      AND NOT EXISTS (SELECT 1 FROM pg_database d WHERE d.datname = current_database() AND pg_has_role(current_user, d.datdba, 'USAGE'))
      AND NOT EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname = 'farm' AND pg_has_role(current_user, n.nspowner, 'USAGE'))
      AND NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname IN ('farm_pairing_runtime', 'farm_pairing_proof_runtime', 'farm_connector_revoker', 'farm_password_auth', 'farm_session_runtime', 'farm_enrollment_approver', 'farm_connector_inventory', 'farm_enrollment_reader', 'farm_telemetry_writer') AND r.rolname <> ${expectedRole} AND pg_has_role(current_user, r.oid, 'USAGE')) AS allowed`
  if (rows[0]?.allowed !== true)
    throw new Error('Invalid pairing database role')
}
export function connectorPairingRuntime(): Promise<PairingRuntime> {
  pairingConfiguredOrigin()
  const raw: unknown = useRuntimeConfig().connectorPairing
  if (instance) return instance
  instance = (async () => {
    try {
      const config = PairingRuntimeConfig.parse(raw)
      const privateKey = await loadPairingSigningKey(config.signingKeyPath)
      const pool = (url: string) => {
        const sql = postgres(url, {
          max: 3,
          connect_timeout: 3,
          idle_timeout: 20,
          connection: { statement_timeout: 2000, lock_timeout: 1000 },
        })
        pools.push(sql)
        return sql
      }
      const pairingSql = pool(config.databaseUrl)
      const proofSql = pool(config.proofDatabaseUrl)
      const revocationSql = pool(config.revocationDatabaseUrl)
      await validateRuntimeRole(pairingSql, 'farm_pairing_runtime')
      await validateRuntimeRole(proofSql, 'farm_pairing_proof_runtime')
      await validateRuntimeRole(revocationSql, 'farm_connector_revoker')
      const binding = { origin: config.origin, audience: config.audience }
      return {
        origin: config.origin,
        pairing: new PostgresPairing(pairingSql, binding),
        proof: new PostgresPairingProof(proofSql, binding),
        revocation: new PostgresConnectorRevocation(revocationSql),
        issuer: {
          issuer: config.issuer,
          audience: config.audience,
          kid: config.signingKeyId,
          privateKey,
          ttlSeconds: config.tokenTtlSeconds,
        },
      }
    } catch {
      await closeConnectorPairingRuntime()
      throw createError({
        status: 503,
        message: 'Pareamento indisponível. Tente novamente.',
      })
    }
  })()
  return instance
}
export async function closeConnectorPairingRuntime(): Promise<void> {
  const closing = pools.splice(0)
  instance = undefined
  await Promise.all(closing.map((sql) => sql.end({ timeout: 3 })))
}
