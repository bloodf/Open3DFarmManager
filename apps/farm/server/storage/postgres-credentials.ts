import { createHash, randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'

export interface CredentialSnapshot {
  accountId: string
  passwordHash: string
  credentialVersion: string
  sessionVersion: string
}

export class PostgresCredentials {
  private readonly sql: Sql
  constructor(sql: Sql) {
    this.sql = sql
  }
  async consumeLimit(kind: 'a' | 's', value: string): Promise<boolean> {
    const key = kind + ':' + createHash('sha256').update(value).digest('hex')
    const limit = kind === 's' ? 60 : 15
    return await this.sql.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout = '2000ms'`
      await tx`SET LOCAL lock_timeout = '1000ms'`
      await tx`DELETE FROM farm.auth_rate_limits WHERE window_start < clock_timestamp() - interval '30 minutes' AND key IN (SELECT key FROM farm.auth_rate_limits WHERE window_start < clock_timestamp() - interval '30 minutes' ORDER BY key LIMIT 100)`
      const rows =
        await tx`INSERT INTO farm.auth_rate_limits (key, window_start, attempts) VALUES (${key}, clock_timestamp(), 1)
        ON CONFLICT (key) DO UPDATE SET
          attempts = CASE WHEN farm.auth_rate_limits.window_start <= clock_timestamp() - interval '15 minutes' THEN 1 ELSE LEAST(farm.auth_rate_limits.attempts + 1, 61) END,
          window_start = CASE WHEN farm.auth_rate_limits.window_start <= clock_timestamp() - interval '15 minutes' THEN clock_timestamp() ELSE farm.auth_rate_limits.window_start END
        RETURNING attempts`
      return rows[0]?.attempts <= limit
    })
  }
  async find(username: string): Promise<CredentialSnapshot | null> {
    const rows = await this
      .sql`SELECT c.account_id AS "accountId", c.password_hash AS "passwordHash", c.credential_version::text AS "credentialVersion", a.session_version::text AS "sessionVersion"
      FROM farm.password_credentials c JOIN farm.session_accounts a ON a.id = c.account_id WHERE c.username = ${username}`
    const row = rows[0]
    if (!row) return null
    if (
      typeof row.accountId !== 'string' ||
      typeof row.passwordHash !== 'string' ||
      typeof row.credentialVersion !== 'string' ||
      typeof row.sessionVersion !== 'string'
    )
      throw new Error('Invalid credential state')
    return {
      accountId: row.accountId,
      passwordHash: row.passwordHash,
      credentialVersion: row.credentialVersion,
      sessionVersion: row.sessionVersion,
    }
  }
  async issue(
    snapshot: CredentialSnapshot,
    now: number,
    lifetimeMs: number,
  ): Promise<string | null> {
    if (
      !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(lifetimeMs) ||
      lifetimeMs <= 0 ||
      !Number.isSafeInteger(now + lifetimeMs)
    )
      throw new Error('Invalid session lifetime')
    return await this.sql.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout = '2000ms'`
      await tx`SET LOCAL lock_timeout = '1000ms'`
      const accounts =
        await tx`SELECT disabled, session_version::text AS version FROM farm.session_accounts WHERE id = ${snapshot.accountId} FOR UPDATE`
      const account = accounts[0]
      if (
        !account ||
        account.disabled ||
        account.version !== snapshot.sessionVersion
      )
        return null
      const credentials =
        await tx`SELECT password_hash, credential_version::text AS version FROM farm.password_credentials WHERE account_id = ${snapshot.accountId} FOR UPDATE`
      if (
        credentials[0]?.version !== snapshot.credentialVersion ||
        credentials[0]?.password_hash !== snapshot.passwordHash
      )
        return null
      const id = randomUUID()
      await tx`INSERT INTO farm.account_sessions (id, account_id, account_version, created_at, last_seen_at, absolute_expires_at) VALUES (${id}, ${snapshot.accountId}, ${snapshot.sessionVersion}, ${now}, ${now}, ${now + lifetimeMs})`
      return id
    })
  }
}
