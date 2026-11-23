import type { Sql, TransactionSql } from 'postgres'
import type {
  AssignableRole,
  FarmInvite,
  FarmMember,
  InviteRevocation,
  MemberChange,
  MembersStore,
} from '../services/members.ts'

/** Owner-only member and invite management. Each method is one bounded transaction. */
export class PostgresMembers implements MembersStore {
  private readonly sql: Sql
  constructor(sql: Sql) {
    this.sql = sql
  }
  private async run<T>(
    operation: (tx: TransactionSql) => Promise<T>,
  ): Promise<T> {
    return (await this.sql.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout = '2000ms'`
      await tx`SET LOCAL lock_timeout = '1000ms'`
      return await operation(tx)
    })) as T
  }
  private async owner(
    tx: TransactionSql,
    actorId: string,
    farmId: string,
  ): Promise<boolean> {
    const rows =
      await tx`SELECT 1 FROM farm.memberships m JOIN farm.session_accounts a ON a.id = m.account_id WHERE m.farm_id = ${farmId}::uuid AND m.account_id = ${actorId} AND m.role = 'owner' AND m.revoked_at IS NULL AND NOT a.disabled FOR SHARE OF m, a`
    return rows.length > 0
  }
  /**
   * Locks every active owner row of the farm, so concurrent removals and demotions
   * serialize and each one counts the owners left by the previous one.
   */
  private async change(
    tx: TransactionSql,
    actorId: string,
    farmId: string,
    accountId: string,
  ): Promise<MemberChange> {
    const owners =
      await tx`SELECT m.account_id FROM farm.memberships m JOIN farm.session_accounts a ON a.id = m.account_id WHERE m.farm_id = ${farmId}::uuid AND m.role = 'owner' AND m.revoked_at IS NULL AND NOT a.disabled ORDER BY m.account_id FOR UPDATE OF m`
    const ids = owners.map((row) => row.account_id as string)
    if (!ids.includes(actorId)) return 'not-found'
    const target =
      await tx`SELECT role FROM farm.memberships WHERE farm_id = ${farmId}::uuid AND account_id = ${accountId} AND revoked_at IS NULL FOR UPDATE`
    if (!target.length) return 'not-found'
    if (ids.includes(accountId) && ids.length <= 1) return 'last-owner'
    return 'ok'
  }
  async listMembers(
    actorId: string,
    farmId: string,
  ): Promise<FarmMember[] | null> {
    return await this.run(async (tx) => {
      if (!(await this.owner(tx, actorId, farmId))) return null
      return await tx<
        FarmMember[]
      >`SELECT m.account_id AS "accountId", c.username, m.role FROM farm.memberships m LEFT JOIN farm.password_credentials c ON c.account_id = m.account_id WHERE m.farm_id = ${farmId}::uuid AND m.revoked_at IS NULL ORDER BY c.username, m.account_id`
    }).then((rows) => rows && rows.map((row) => ({ ...row })))
  }
  async changeRole(
    actorId: string,
    farmId: string,
    accountId: string,
    role: AssignableRole,
  ): Promise<MemberChange> {
    return await this.run(async (tx) => {
      const decision = await this.change(tx, actorId, farmId, accountId)
      if (decision === 'ok')
        await tx`UPDATE farm.memberships SET role = ${role} WHERE farm_id = ${farmId}::uuid AND account_id = ${accountId}`
      return decision
    })
  }
  async removeMember(
    actorId: string,
    farmId: string,
    accountId: string,
    now: number,
  ): Promise<MemberChange> {
    return await this.run(async (tx) => {
      const decision = await this.change(tx, actorId, farmId, accountId)
      if (decision !== 'ok') return decision
      await tx`UPDATE farm.memberships SET revoked_at = ${now} WHERE farm_id = ${farmId}::uuid AND account_id = ${accountId}`
      // Sessions are not farm-scoped: a new account version ends all of them at once.
      await tx`UPDATE farm.session_accounts SET session_version = session_version + 1 WHERE id = ${accountId}`
      return decision
    })
  }
  async listInvites(
    actorId: string,
    farmId: string,
  ): Promise<FarmInvite[] | null> {
    return await this.run(async (tx) => {
      if (!(await this.owner(tx, actorId, farmId))) return null
      const rows =
        await tx`SELECT i.id, i.role, i.created_at, i.expires_at, CASE WHEN i.revoked_at IS NOT NULL THEN 'revoked' WHEN i.consumed_at IS NOT NULL THEN 'consumed' WHEN i.expires_at <= clock_timestamp() THEN 'expired' ELSE 'pending' END AS status FROM farm.account_invites i WHERE i.farm_id = ${farmId}::uuid ORDER BY i.created_at DESC, i.id LIMIT 200`
      return rows.map((row) => ({
        id: row.id as string,
        role: row.role as AssignableRole,
        createdAt: (row.created_at as Date).toISOString(),
        expiresAt: (row.expires_at as Date).toISOString(),
        status: row.status as FarmInvite['status'],
      }))
    })
  }
  async revokeInvite(
    actorId: string,
    farmId: string,
    inviteId: string,
  ): Promise<InviteRevocation> {
    return await this.run(async (tx) => {
      if (!(await this.owner(tx, actorId, farmId))) return 'not-found'
      const rows =
        await tx`SELECT consumed_at, revoked_at FROM farm.account_invites WHERE id = ${inviteId}::uuid AND farm_id = ${farmId}::uuid FOR UPDATE`
      const invite = rows[0]
      if (!invite) return 'not-found'
      if (invite.consumed_at !== null) return 'consumed'
      if (invite.revoked_at === null)
        await tx`UPDATE farm.account_invites SET revoked_at = clock_timestamp(), revoked_by = ${actorId} WHERE id = ${inviteId}::uuid`
      return 'ok'
    })
  }
}
