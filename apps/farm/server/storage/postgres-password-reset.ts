import type { Sql, TransactionSql } from 'postgres'
import type { PasswordResetStore } from '../services/password-reset.ts'
import type {
  IssuedResetLink,
  ResetLinkRefusal,
  ResetLinkStore,
} from '../services/password-reset-links.ts'

export class PostgresPasswordReset
  implements PasswordResetStore, ResetLinkStore
{
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
      await tx`INSERT INTO farm.password_reset_tokens (account_id, digest, credential_version, issued_at, expires_at, owner_farm_id)
        VALUES (${account.id}, ${digest}, ${credentials[0].credential_version}, statement_timestamp(), statement_timestamp() + interval '15 minutes', NULL)
        ON CONFLICT (account_id) DO UPDATE SET digest = EXCLUDED.digest, credential_version = EXCLUDED.credential_version, issued_at = EXCLUDED.issued_at, expires_at = EXCLUDED.expires_at, owner_farm_id = EXCLUDED.owner_farm_id`
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
        await tx`DELETE FROM farm.password_reset_tokens WHERE account_id = ${account.id} AND digest = ${digest} AND credential_version = ${credentials[0].credential_version} AND issued_at <= clock_timestamp() AND expires_at > clock_timestamp() RETURNING owner_farm_id`
      if (!tokens[0]) return false
      const ownerFarm = tokens[0].owner_farm_id as string | null
      // An owner-issued link stays valid only while the issuing farm is still the
      // account's one active membership; the token is spent either way.
      if (
        ownerFarm !== null &&
        !(await soleMembership(tx, account.id, ownerFarm))
      )
        return false
      await tx`UPDATE farm.password_credentials SET password_hash = ${passwordHash}, credential_version = credential_version + 1 WHERE account_id = ${account.id}`
      await tx`UPDATE farm.session_accounts SET session_version = session_version + 1 WHERE id = ${account.id}`
      return true
    })
  }
  async issueForMember(
    actorId: string,
    farmId: string,
    accountId: string,
    digest: string,
  ): Promise<IssuedResetLink | ResetLinkRefusal | null> {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid reset digest')
    return await this.sql.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout = '2000ms'`
      await tx`SET LOCAL lock_timeout = '1000ms'`
      const owners =
        await tx`SELECT 1 FROM farm.memberships m JOIN farm.session_accounts a ON a.id = m.account_id WHERE m.farm_id = ${farmId}::uuid AND m.account_id = ${actorId} AND m.role = 'owner' AND m.revoked_at IS NULL AND NOT a.disabled`
      if (!owners.length) return null
      if (actorId === accountId) return { refused: 'self' }
      // Same lock order as login, issue and consume: account, then credential.
      const targets =
        await tx`SELECT a.id, c.username FROM farm.memberships m JOIN farm.session_accounts a ON a.id = m.account_id JOIN farm.password_credentials c ON c.account_id = a.id WHERE m.farm_id = ${farmId}::uuid AND m.account_id = ${accountId} AND m.revoked_at IS NULL AND NOT a.disabled FOR UPDATE OF a`
      const target = targets[0]
      if (!target) return null
      // Accounts are global: an account that also belongs to another farm is not
      // this owner's to reset. The account row lock above blocks any concurrent
      // membership insert (its foreign key needs a KEY SHARE lock on that row), and
      // revocation is terminal, so the answer cannot change before commit.
      if (!(await soleMembership(tx, target.id, farmId)))
        return { refused: 'shared-account' }
      const credentials =
        await tx`SELECT credential_version FROM farm.password_credentials WHERE account_id = ${target.id} FOR UPDATE`
      if (!credentials[0]) return null
      const tokens =
        await tx`INSERT INTO farm.password_reset_tokens (account_id, digest, credential_version, issued_at, expires_at, owner_farm_id)
        VALUES (${target.id}, ${digest}, ${credentials[0].credential_version}, statement_timestamp(), statement_timestamp() + interval '15 minutes', ${farmId}::uuid)
        ON CONFLICT (account_id) DO UPDATE SET digest = EXCLUDED.digest, credential_version = EXCLUDED.credential_version, issued_at = EXCLUDED.issued_at, expires_at = EXCLUDED.expires_at, owner_farm_id = EXCLUDED.owner_farm_id
        RETURNING expires_at`
      return {
        username: target.username as string,
        expiresAt: tokens[0]?.expires_at as Date,
      }
    })
  }
}

/** True when farmId is the account's one and only active membership. Caller holds the account row lock. */
async function soleMembership(
  tx: TransactionSql,
  accountId: string,
  farmId: string,
): Promise<boolean> {
  const rows =
    await tx`SELECT count(*) FILTER (WHERE farm_id = ${farmId}::uuid)::int AS own, count(*) FILTER (WHERE farm_id <> ${farmId}::uuid)::int AS other FROM farm.memberships WHERE account_id = ${accountId} AND revoked_at IS NULL`
  return rows[0]?.own === 1 && rows[0]?.other === 0
}
