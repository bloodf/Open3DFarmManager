import { randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'

export type InviteRole = 'admin' | 'operator' | 'viewer'
const BOOTSTRAP_LOCK = 4_240_001

/** Digests only: callers hash tokens; no bearer token reaches storage. */
export class PostgresRegistration {
  private readonly sql: Sql
  constructor(sql: Sql) {
    this.sql = sql
  }
  /** Creates the first account, its farm and owner membership. False once any account exists. */
  async bootstrap(username: string, passwordHash: string): Promise<boolean> {
    return await this.sql.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout = '2000ms'`
      await tx`SET LOCAL lock_timeout = '1000ms'`
      await tx`SELECT pg_advisory_xact_lock(${BOOTSTRAP_LOCK})`
      if ((await tx`SELECT 1 FROM farm.session_accounts LIMIT 1`).length)
        return false
      const accountId = randomUUID()
      const farmId = randomUUID()
      await tx`INSERT INTO farm.session_accounts (id) VALUES (${accountId})`
      await tx`INSERT INTO farm.password_credentials (account_id, username, password_hash) VALUES (${accountId}, ${username}, ${passwordHash})`
      await tx`INSERT INTO farm.farms (id) VALUES (${farmId})`
      await tx`INSERT INTO farm.memberships (farm_id, account_id, role) VALUES (${farmId}, ${accountId}, 'owner')`
      return true
    })
  }
  /** Active owners only. Returns null for non-owners and unknown farms. */
  async createInvite(
    accountId: string,
    farmId: string,
    role: InviteRole,
    digest: string,
    ttlMs: number,
  ): Promise<Date | null> {
    return await this.sql.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout = '2000ms'`
      await tx`SET LOCAL lock_timeout = '1000ms'`
      const owners =
        await tx`SELECT 1 FROM farm.memberships m JOIN farm.session_accounts a ON a.id = m.account_id WHERE m.farm_id = ${farmId}::uuid AND m.account_id = ${accountId} AND m.role = 'owner' AND m.revoked_at IS NULL AND NOT a.disabled FOR SHARE OF m, a`
      if (!owners.length) return null
      const rows =
        await tx`INSERT INTO farm.account_invites (farm_id, role, digest, created_by, expires_at) VALUES (${farmId}::uuid, ${role}, ${digest}, ${accountId}, clock_timestamp() + ${ttlMs} * interval '1 millisecond') RETURNING expires_at`
      return rows[0]?.expires_at instanceof Date ? rows[0].expires_at : null
    })
  }
  /** Atomically consumes a valid invite and creates the account. Invite stays usable on any failure. */
  async register(
    digest: string,
    username: string,
    passwordHash: string,
  ): Promise<boolean> {
    return await this.sql
      .begin(async (tx) => {
        await tx`SET LOCAL statement_timeout = '2000ms'`
        await tx`SET LOCAL lock_timeout = '1000ms'`
        const invites =
          await tx`SELECT i.id, i.farm_id, i.role FROM farm.account_invites i
          JOIN farm.memberships m ON m.farm_id = i.farm_id AND m.account_id = i.created_by AND m.role = 'owner' AND m.revoked_at IS NULL
          JOIN farm.session_accounts a ON a.id = i.created_by AND NOT a.disabled
          WHERE i.digest = ${digest} AND i.consumed_at IS NULL AND i.expires_at > clock_timestamp() FOR UPDATE OF i FOR SHARE OF m, a`
        const invite = invites[0]
        if (!invite) return false
        const accountId = randomUUID()
        await tx`INSERT INTO farm.session_accounts (id) VALUES (${accountId})`
        const created =
          await tx`INSERT INTO farm.password_credentials (account_id, username, password_hash) VALUES (${accountId}, ${username}, ${passwordHash}) ON CONFLICT (username) DO NOTHING RETURNING account_id`
        if (!created.length) {
          // Throwing rolls back the account row too; the invite remains unconsumed.
          throw new RegistrationConflict()
        }
        await tx`INSERT INTO farm.memberships (farm_id, account_id, role) VALUES (${invite.farm_id}, ${accountId}, ${invite.role})`
        await tx`UPDATE farm.account_invites SET consumed_at = clock_timestamp(), consumed_by = ${accountId} WHERE id = ${invite.id}`
        return true
      })
      .catch((error: unknown) => {
        if (error instanceof RegistrationConflict) return false
        throw error
      })
  }
}
class RegistrationConflict extends Error {}
