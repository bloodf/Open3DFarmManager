import type { Sql } from 'postgres'
import {
  evaluateSession,
  type AccountSessionState,
  type SessionPolicy,
  type SessionRecord,
} from '../utils/auth/session-contract.ts'

export type SlotRole = 'owner' | 'admin' | 'operator' | 'viewer'
export interface SlotAuthority {
  farmId: string
  sessionRecordId: string
  policy: SessionPolicy
}
export interface SlotAccess {
  /** Resolves the caller's role in the farm, or throws SlotAccessError. */
  authorize(authority: SlotAuthority): Promise<SlotRole>
}
export class SlotAccessError extends Error {
  readonly status: number
  constructor(status: number) {
    super('Spool slot request rejected')
    this.status = status
  }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Session and farm-membership authority for the slot routes. 401: no live session. 404: not a member. */
export class PostgresSpoolSlotAccess implements SlotAccess {
  constructor(
    private readonly sql: Sql,
    private readonly clock: () => number = Date.now,
  ) {}

  async authorize(authority: SlotAuthority): Promise<SlotRole> {
    if (
      !uuid.test(authority.farmId) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(authority.sessionRecordId)
    )
      throw new SlotAccessError(400)
    return this.sql.begin(async (tx) => {
      const accounts = await tx<
        AccountSessionState[]
      >`SELECT id, session_version::float8 AS "sessionVersion", disabled FROM farm.session_accounts WHERE id=(SELECT account_id FROM farm.account_sessions WHERE id=${authority.sessionRecordId}) FOR SHARE`
      const sessions = await tx<
        SessionRecord[]
      >`SELECT id, account_id AS "accountId", account_version::float8 AS "accountVersion", created_at::float8 AS "createdAt", last_seen_at::float8 AS "lastSeenAt", absolute_expires_at::float8 AS "absoluteExpiresAt", revoked_at::float8 AS "revokedAt" FROM farm.account_sessions WHERE id=${authority.sessionRecordId} FOR UPDATE`
      const now = this.clock()
      const decision = evaluateSession(
        authority.sessionRecordId,
        sessions[0] ?? null,
        accounts[0] ?? null,
        now,
        authority.policy,
      )
      if (!decision.ok) throw new SlotAccessError(401)
      const members =
        await tx`SELECT role, revoked_at FROM farm.memberships WHERE farm_id=${authority.farmId}::uuid AND account_id=${decision.accountId} FOR SHARE`
      const role: unknown =
        members[0]?.revoked_at === null ? members[0]?.role : null
      if (!['owner', 'admin', 'operator', 'viewer'].includes(role as string))
        throw new SlotAccessError(404)
      await tx`UPDATE farm.account_sessions SET last_seen_at=${now} WHERE id=${authority.sessionRecordId}`
      return role as SlotRole
    })
  }
}
