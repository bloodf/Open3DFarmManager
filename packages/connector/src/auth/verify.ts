import { createPublicKey, verify } from 'node:crypto'
import { z } from 'zod'
import {
  canonicalize,
  decodeBase64url,
  decodeCommand,
} from '@open3dfarmmanager/farm-protocol'
import type { SignedCommand } from '@open3dfarmmanager/farm-protocol'
import { OFFLINE_AUTHORITY_MAX_MS } from './offline-authority.ts'

const coordinate = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/)
const PublicKey = z.strictObject({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  x: coordinate,
  y: coordinate,
  ext: z.boolean().optional(),
  key_ops: z.array(z.literal('verify')).length(1).optional(),
  alg: z.literal('ES256').optional(),
})
export type ClaimResult =
  'accepted' | 'replay' | 'capacity' | 'clock-regressed' | 'rate-limited'
export interface ReplayStore {
  claim(command: SignedCommand, now: number): ClaimResult
}
export interface CommandContext {
  farmId: string
  agentId: string
  userId: string
  keyId: string
  sessionId: string
  printerIds: ReadonlySet<string>
  now: number
  authorization: { issuedAt: number; expiresAt: number }
  key: {
    id: string
    farmId: string
    userId: string
    role: 'viewer' | 'operator' | 'admin' | 'owner'
    revokedAt: number | null
    publicJwk: unknown
  }
}
const ContextShape = z.strictObject({
  farmId: z.string().uuid(),
  agentId: z.string().uuid(),
  userId: z.string().uuid(),
  keyId: z.string().uuid(),
  sessionId: z.string().uuid(),
  printerIds: z.set(z.string().uuid()),
  now: z.number(),
  authorization: z.strictObject({
    issuedAt: z.number(),
    expiresAt: z.number(),
  }),
  key: z.strictObject({
    id: z.string().uuid(),
    farmId: z.string().uuid(),
    userId: z.string().uuid(),
    role: z.string(),
    revokedAt: z.number().int().nonnegative().nullable(),
    publicJwk: z.unknown(),
  }),
})

export type CommandRejectionReason =
  | Exclude<ClaimResult, 'accepted'>
  | 'invalid-command'
  | 'invalid-context'
  | 'invalid-clock'
  | 'scope-mismatch'
  | 'unknown-printer'
  | 'revoked-key'
  | 'role-denied'
  | 'invalid-authorization'
  | 'authorization-expired'
  | 'command-expired'
  | 'clock-window'
  | 'invalid-key-or-signature'
  | 'invalid-signature'
  | 'storage-unavailable'

export type CommandDecision =
  | { ok: true; command: SignedCommand }
  | { ok: false; reason: CommandRejectionReason }

// Returns authorization only. No driver, transport, retries or physical side effects.
export function authorizeCommand(
  wire: string,
  context: CommandContext,
  replay: ReplayStore,
): CommandDecision {
  let command: SignedCommand
  try {
    command = decodeCommand(wire)
  } catch {
    return { ok: false, reason: 'invalid-command' }
  }
  // Runtime shape checks are not authentication; the caller must supply trusted context.
  const parsedContext = ContextShape.safeParse(context)
  if (!parsedContext.success) return { ok: false, reason: 'invalid-context' }
  const { key, now, authorization } = parsedContext.data
  if (!Number.isSafeInteger(now) || now < 0)
    return { ok: false, reason: 'invalid-clock' }
  if (
    command.farm_id !== parsedContext.data.farmId ||
    command.agent_id !== parsedContext.data.agentId ||
    command.user_id !== parsedContext.data.userId ||
    command.key_id !== parsedContext.data.keyId ||
    command.session_id !== parsedContext.data.sessionId ||
    key.id !== parsedContext.data.keyId ||
    key.farmId !== parsedContext.data.farmId ||
    key.userId !== parsedContext.data.userId
  )
    return { ok: false, reason: 'scope-mismatch' }
  if (!parsedContext.data.printerIds.has(command.printer_id))
    return { ok: false, reason: 'unknown-printer' }
  if (key.revokedAt !== null) return { ok: false, reason: 'revoked-key' }
  if (!['operator', 'admin', 'owner'].includes(key.role))
    return { ok: false, reason: 'role-denied' }
  // Provisional fail-closed lease for this prototype; the lease is caller-supplied and transport
  // must authenticate its provenance. This length cap alone does not enforce the offline lifetime.
  if (
    ![authorization.issuedAt, authorization.expiresAt].every(
      Number.isSafeInteger,
    ) ||
    authorization.issuedAt < 0 ||
    authorization.issuedAt > now ||
    authorization.expiresAt <= authorization.issuedAt ||
    authorization.expiresAt - authorization.issuedAt > OFFLINE_AUTHORITY_MAX_MS
  )
    return { ok: false, reason: 'invalid-authorization' }
  if (authorization.expiresAt <= now)
    return { ok: false, reason: 'authorization-expired' }
  if (command.expires_at <= now) return { ok: false, reason: 'command-expired' }
  if (Math.abs(command.issued_at - now) > 60_000)
    return { ok: false, reason: 'clock-window' }
  let valid = false
  try {
    const publicJwk = PublicKey.parse(key.publicJwk)
    const publicKey = createPublicKey({ key: publicJwk, format: 'jwk' })
    const { sig, ...unsigned } = command
    valid = verify(
      'sha256',
      Buffer.from(canonicalize(unsigned)),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      decodeBase64url(sig, 64),
    )
  } catch {
    return { ok: false, reason: 'invalid-key-or-signature' }
  }
  if (!valid) return { ok: false, reason: 'invalid-signature' }
  try {
    const result = replay.claim(command, now)
    switch (result) {
      case 'accepted':
        return { ok: true, command }
      case 'replay':
      case 'capacity':
      case 'clock-regressed':
      case 'rate-limited':
        return { ok: false, reason: result }
      default:
        return { ok: false, reason: 'storage-unavailable' }
    }
  } catch {
    return { ok: false, reason: 'storage-unavailable' }
  }
}
