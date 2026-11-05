import type { Sql } from 'postgres'
import {
  evaluateSession,
  type SessionRecord,
  type AccountSessionState,
  type SessionDecision,
  type SessionPolicy,
  type SessionRepository,
} from '../utils/auth/session-contract.ts'

const validId = (id: string) =>
  typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)
const validTime = (now: number) => Number.isSafeInteger(now) && now >= 0

/** Unwired persistence adapter. The caller owns a dedicated, bounded SQL pool. */
export class PostgresSessionRepository implements SessionRepository {
  private readonly sql: Sql
  constructor(sql: Sql) {
    this.sql = sql
  }

  async authorizeAndTouch(
    id: string,
    now: number,
    policy: SessionPolicy,
  ): Promise<SessionDecision> {
    const input = evaluateSession(id, null, null, now, policy)
    if (!input.ok && input.reason === 'invalid-state') return input
    try {
      return await this.sql.begin(async (tx): Promise<SessionDecision> => {
        await tx`SET LOCAL statement_timeout = '2000ms'`
        await tx`SET LOCAL lock_timeout = '1000ms'`
        // Account binding is immutable. Always lock account before session.
        const accounts = await tx<AccountSessionState[]>`
          SELECT id, session_version::float8 AS "sessionVersion", disabled
          FROM farm.session_accounts
          WHERE id = (SELECT account_id FROM farm.account_sessions WHERE id = ${id})
          FOR UPDATE
        `
        const sessions = await tx<SessionRecord[]>`
          SELECT id, account_id AS "accountId", account_version::float8 AS "accountVersion",
            created_at::float8 AS "createdAt", last_seen_at::float8 AS "lastSeenAt",
            absolute_expires_at::float8 AS "absoluteExpiresAt", revoked_at::float8 AS "revokedAt"
          FROM farm.account_sessions WHERE id = ${id} FOR UPDATE
        `
        // evaluateSession validates every field from the database before accepting it.
        const decision = evaluateSession(
          id,
          sessions[0] ?? null,
          accounts[0] ?? null,
          now,
          policy,
        )
        if (decision.ok)
          await tx`UPDATE farm.account_sessions SET last_seen_at = ${decision.touchAt} WHERE id = ${id}`
        else if (decision.reason === 'expired')
          await tx`UPDATE farm.account_sessions SET revoked_at = ${now} WHERE id = ${id}`
        return decision
      })
    } catch {
      return { ok: false, reason: 'storage-unavailable' }
    }
  }

  async revokeSession(id: string, now: number): Promise<void> {
    if (!validId(id) || !validTime(now))
      throw new Error('Invalid revocation request')
    try {
      await this.sql.begin(async (tx) => {
        await tx`SET LOCAL statement_timeout = '2000ms'`
        await tx`SET LOCAL lock_timeout = '1000ms'`
        await tx`SELECT id FROM farm.session_accounts WHERE id = (SELECT account_id FROM farm.account_sessions WHERE id = ${id}) FOR UPDATE`
        const rows =
          await tx`SELECT last_seen_at::float8 AS "lastSeenAt", revoked_at FROM farm.account_sessions WHERE id = ${id} FOR UPDATE`
        const session = rows[0]
        if (!session || session.revoked_at !== null) return
        if (now < session.lastSeenAt) throw new Error('Invalid revocation time')
        await tx`UPDATE farm.account_sessions SET revoked_at = ${now} WHERE id = ${id}`
      })
    } catch {
      throw new Error('Session storage unavailable')
    }
  }

  async revokeAccountSessions(id: string): Promise<void> {
    if (!validId(id)) throw new Error('Invalid revocation request')
    try {
      await this.sql.begin(async (tx) => {
        await tx`SET LOCAL statement_timeout = '2000ms'`
        await tx`SET LOCAL lock_timeout = '1000ms'`
        // The constraint rejects exhaustion rather than wrapping or reusing a version.
        await tx`UPDATE farm.session_accounts SET session_version = session_version + 1 WHERE id = ${id}`
      })
    } catch {
      throw new Error('Session storage unavailable')
    }
  }
}
