import { createPublicKey, verify } from 'node:crypto'
import { z } from 'zod'
import {
  canonicalize,
  decodeBase64url,
  decodeCommand,
} from '@open3dfarmmanager/farm-protocol'
import type { SignedCommand } from '@open3dfarmmanager/farm-protocol'

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
  | 'accepted'
  | 'replay'
  | 'capacity'
  | 'clock-regressed'
  | 'rate-limited'
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
export type CommandDecision =
  | { ok: true; command: SignedCommand }
  | { ok: false; reason: string }

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
  const { key, now, authorization } = context
  if (!Number.isSafeInteger(now) || now < 0)
    return { ok: false, reason: 'invalid-clock' }
  if (
    command.farm_id !== context.farmId ||
    command.agent_id !== context.agentId ||
    command.user_id !== context.userId ||
    command.key_id !== context.keyId ||
    command.session_id !== context.sessionId ||
    key.id !== context.keyId ||
    key.farmId !== context.farmId ||
    key.userId !== context.userId
  )
    return { ok: false, reason: 'scope-mismatch' }
  if (!context.printerIds.has(command.printer_id))
    return { ok: false, reason: 'unknown-printer' }
  if (key.revokedAt !== null) return { ok: false, reason: 'revoked-key' }
  if (!['operator', 'admin', 'owner'].includes(key.role))
    return { ok: false, reason: 'role-denied' }
  // Provisional fail-closed lease for this prototype; transport must authenticate its provenance.
  if (
    ![authorization.issuedAt, authorization.expiresAt].every(
      Number.isSafeInteger,
    ) ||
    authorization.issuedAt < 0 ||
    authorization.issuedAt > now ||
    authorization.expiresAt <= authorization.issuedAt ||
    authorization.expiresAt - authorization.issuedAt > 60_000
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
    return result === 'accepted'
      ? { ok: true, command }
      : { ok: false, reason: result }
  } catch {
    return { ok: false, reason: 'storage-unavailable' }
  }
}
