import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto'

/**
 * Legacy-client credential: `sl1.<credential id, 32 hex>.<secret, 43 base64url>`.
 * It travels in the server URL path of clients that cannot authenticate, so it
 * is a bearer secret: 256 random bits, stored only as a SHA-256, never logged.
 */
export const LEGACY_TOKEN_PATTERN = /^sl1\.([0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/

export interface ParsedLegacyToken {
  credentialId: string
  secret: string
}

export function issueLegacyToken(): {
  credentialId: string
  token: string
  secretSha256: string
} {
  const credentialId = randomUUID()
  const secret = randomBytes(32).toString('base64url')
  return {
    credentialId,
    token: `sl1.${credentialId.replaceAll('-', '')}.${secret}`,
    secretSha256: hashSecret(secret),
  }
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

export function parseLegacyToken(value: unknown): ParsedLegacyToken | null {
  if (typeof value !== 'string' || value.length > 96) return null
  const match = LEGACY_TOKEN_PATTERN.exec(value)
  const hex = match?.[1]
  const secret = match?.[2]
  if (!hex || !secret) return null
  const credentialId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  return { credentialId, secret }
}

/** Constant-time comparison of a presented secret with the stored hash. */
export function secretMatches(secret: string, storedSha256: string): boolean {
  const presented = Buffer.from(hashSecret(secret), 'hex')
  const stored = Buffer.from(storedSha256, 'hex')
  return (
    stored.length === presented.length && timingSafeEqual(presented, stored)
  )
}

/** Hash compared for unknown credential ids so timing does not reveal existence. */
export const DECOY_SHA256 = hashSecret('spool-library-decoy')
