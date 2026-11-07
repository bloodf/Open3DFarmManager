import type { Sql } from 'postgres'
import type { PasswordResetStore } from '../services/password-reset.ts'

export class PostgresPasswordReset implements PasswordResetStore {
  private readonly sql: Sql
  constructor(sql: Sql) {
    this.sql = sql
  }
  async issue(username: string, digest: string): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid reset digest')
    return await this.sql.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout = '2000ms'`
      await tx`SET LOCAL lock_timeout = '1000ms'`
      const accounts =
        await tx`SELECT a.id FROM farm.session_accounts a JOIN farm.password_credentials c ON c.account_id = a.id WHERE c.username = ${username} AND NOT a.disabled FOR UPDATE OF a`
      const account = accounts[0]
      if (!account) return false
      const credentials =
        await tx`SELECT credential_version FROM farm.password_credentials WHERE account_id = ${account.id} FOR UPDATE`
      if (!credentials[0]) return false
      await tx`INSERT INTO farm.password_reset_tokens (account_id, digest, credential_version, issued_at, expires_at)
        VALUES (${account.id}, ${digest}, ${credentials[0].credential_version}, statement_timestamp(), statement_timestamp() + interval '15 minutes')
        ON CONFLICT (account_id) DO UPDATE SET digest = EXCLUDED.digest, credential_version = EXCLUDED.credential_version, issued_at = EXCLUDED.issued_at, expires_at = EXCLUDED.expires_at`
      return true
    })
  }
  async consume(
    username: string,
    digest: string,
    passwordHash: string,
  ): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(digest)) return false
    return await this.sql.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout = '2000ms'`
      await tx`SET LOCAL lock_timeout = '1000ms'`
      // Match login lock order so reset and session issuance serialize on the account.
      const accounts =
        await tx`SELECT a.id FROM farm.session_accounts a JOIN farm.password_credentials c ON c.account_id = a.id WHERE c.username = ${username} AND NOT a.disabled FOR UPDATE OF a`
      const account = accounts[0]
      if (!account) return false
      const credentials =
        await tx`SELECT credential_version FROM farm.password_credentials WHERE account_id = ${account.id} FOR UPDATE`
      if (!credentials[0]) return false
      const tokens =
        await tx`DELETE FROM farm.password_reset_tokens WHERE account_id = ${account.id} AND digest = ${digest} AND credential_version = ${credentials[0].credential_version} AND issued_at <= clock_timestamp() AND expires_at > clock_timestamp() RETURNING account_id`
      if (!tokens[0]) return false
      await tx`UPDATE farm.password_credentials SET password_hash = ${passwordHash}, credential_version = credential_version + 1 WHERE account_id = ${account.id}`
      await tx`UPDATE farm.session_accounts SET session_version = session_version + 1 WHERE id = ${account.id}`
      return true
    })
  }
}
