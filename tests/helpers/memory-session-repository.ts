import {
  evaluateSession,
  type AccountSessionState,
  type SessionDecision,
  type SessionPolicy,
  type SessionRecord,
  type SessionRepository,
} from '../../apps/farm/server/utils/auth/session-contract.ts'

const validId = (id: unknown): id is string =>
  typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)
const validInteger = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0

/**
 * TEST DOUBLE ONLY. No disk, credentials, issuance, cross-process locks or durability.
 * Operations run without an await point, modeling one serialized transaction each.
 * Never use this as the application's session store.
 */
export class MemorySessionRepository implements SessionRepository {
  #accounts = new Map<string, AccountSessionState>()
  #sessions = new Map<string, SessionRecord>()
  #available = true
  #lastObservedAt = 0

  constructor(accounts: AccountSessionState[], sessions: SessionRecord[]) {
    for (const input of accounts) {
      const account = { ...input }
      if (
        !validId(account.id) ||
        !validInteger(account.sessionVersion) ||
        typeof account.disabled !== 'boolean' ||
        this.#accounts.has(account.id)
      )
        throw new Error('Invalid session fixture')
      this.#accounts.set(account.id, account)
    }
    for (const input of sessions) {
      const session = { ...input }
      const account = this.#accounts.get(session.accountId)
      const result = evaluateSession(
        session.id,
        session,
        account ?? null,
        session.lastSeenAt,
        { idleTimeoutMs: 1 },
      )
      if (
        !account ||
        this.#sessions.has(session.id) ||
        (!result.ok && result.reason === 'invalid-state')
      )
        throw new Error('Invalid session fixture')
      this.#sessions.set(session.id, session)
      this.#lastObservedAt = Math.max(
        this.#lastObservedAt,
        session.lastSeenAt,
        session.revokedAt ?? 0,
      )
    }
  }

  setAvailableForTest(available: boolean): void {
    this.#available = available
  }
  sessionForTest(id: string): SessionRecord | undefined {
    const row = this.#sessions.get(id)
    return row ? { ...row } : undefined
  }
  accountForTest(id: string): AccountSessionState | undefined {
    const row = this.#accounts.get(id)
    return row ? { ...row } : undefined
  }
  #observe(now: number): boolean {
    if (!validInteger(now) || now < this.#lastObservedAt) return false
    this.#lastObservedAt = now
    return true
  }
  async authorizeAndTouch(
    id: string,
    now: number,
    policy: SessionPolicy,
  ): Promise<SessionDecision> {
    if (!this.#available) return { ok: false, reason: 'storage-unavailable' }
    if (!this.#observe(now)) return { ok: false, reason: 'invalid-state' }
    const session = this.#sessions.get(id) ?? null
    const account = session
      ? (this.#accounts.get(session.accountId) ?? null)
      : null
    const result = evaluateSession(id, session, account, now, policy)
    if (result.ok && session)
      this.#sessions.set(id, { ...session, lastSeenAt: result.touchAt })
    return result
  }
  async revokeSession(id: string, now: number): Promise<void> {
    if (!this.#available) throw new Error('Session storage unavailable')
    if (!validId(id) || !this.#observe(now))
      throw new Error('Invalid revocation request')
    const session = this.#sessions.get(id)
    if (session && session.revokedAt === null)
      this.#sessions.set(id, { ...session, revokedAt: now })
  }
  async revokeAccountSessions(id: string): Promise<void> {
    if (!this.#available) throw new Error('Session storage unavailable')
    if (!validId(id)) throw new Error('Invalid revocation request')
    const account = this.#accounts.get(id)
    if (!account) return
    if (account.sessionVersion === Number.MAX_SAFE_INTEGER)
      throw new Error('Session version exhausted')
    this.#accounts.set(id, {
      ...account,
      sessionVersion: account.sessionVersion + 1,
    })
  }
}
