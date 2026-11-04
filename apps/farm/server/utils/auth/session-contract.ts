/** Unwired persistence contract; IDs here are internal references, never bearer tokens. */
export interface SessionRecord {
  id: string
  accountId: string
  accountVersion: number
  createdAt: number
  lastSeenAt: number
  absoluteExpiresAt: number
  revokedAt: number | null
}
export interface AccountSessionState {
  id: string
  sessionVersion: number
  disabled: boolean
}
export interface SessionPolicy {
  /** Explicitly supplied by reviewed policy, not chosen by this contract. */
  idleTimeoutMs: number
}
export type SessionDecision =
  | { ok: true; accountId: string; touchAt: number }
  | {
      ok: false
      reason:
        | 'invalid-state'
        | 'missing'
        | 'revoked'
        | 'expired'
        | 'storage-unavailable'
    }

/**
 * Future adapters must serialize authorize/touch against revoke operations and read
 * current account state within that transaction. No stale cache or cookie fallback.
 * Database failures return storage-unavailable; never return success before commit.
 */
export interface SessionRepository {
  authorizeAndTouch(
    sessionId: string,
    now: number,
    policy: SessionPolicy,
  ): Promise<SessionDecision>
  /** Idempotent; success means durable revocation, including an already absent ID. */
  revokeSession(sessionId: string, now: number): Promise<void>
  /** Atomically increment the account version; never reuse or decrement it. */
  revokeAccountSessions(accountId: string): Promise<void>
}

const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)

/** Pure reference decision over a fresh database snapshot. Not authentication. */
export function evaluateSession(
  sessionId: string,
  session: SessionRecord | null,
  account: AccountSessionState | null,
  now: number,
  policy: SessionPolicy,
): SessionDecision {
  const invalid: SessionDecision = { ok: false, reason: 'invalid-state' }
  try {
    if (
      !identifier(sessionId) ||
      !integer(now) ||
      !integer(policy.idleTimeoutMs) ||
      policy.idleTimeoutMs === 0
    )
      return invalid
    if (session === null || account === null)
      return { ok: false, reason: 'missing' }
    if (
      !identifier(session.id) ||
      !identifier(session.accountId) ||
      !identifier(account.id) ||
      session.id !== sessionId ||
      session.accountId !== account.id ||
      !integer(session.accountVersion) ||
      !integer(account.sessionVersion) ||
      typeof account.disabled !== 'boolean' ||
      !integer(session.createdAt) ||
      !integer(session.lastSeenAt) ||
      !integer(session.absoluteExpiresAt) ||
      session.createdAt > session.lastSeenAt ||
      session.lastSeenAt >= session.absoluteExpiresAt ||
      now < session.lastSeenAt ||
      (session.revokedAt !== null &&
        (!integer(session.revokedAt) || session.revokedAt < session.createdAt))
    )
      return invalid
    if (
      session.revokedAt !== null ||
      account.disabled ||
      session.accountVersion !== account.sessionVersion
    )
      return { ok: false, reason: 'revoked' }
    if (
      now >= session.absoluteExpiresAt ||
      now - session.lastSeenAt >= policy.idleTimeoutMs
    )
      return { ok: false, reason: 'expired' }
    return { ok: true, accountId: account.id, touchAt: now }
  } catch {
    return invalid
  }
}
