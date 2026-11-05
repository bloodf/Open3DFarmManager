import type { Sql, TransactionSql } from 'postgres'
import {
  evaluateSession,
  type SessionPolicy,
  type SessionRecord,
  type AccountSessionState,
} from '../utils/auth/session-contract.ts'

export const inventoryUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export interface InventoryPageInput {
  sessionRecordId: string
  policy: SessionPolicy
  limit: number
  after: string | null
}
export type InventoryFailure = {
  ok: false
  reason: 'invalid-input' | 'unauthorized' | 'forbidden' | 'storage-unavailable'
}
export interface InventoryConnector {
  agentId: string
  fingerprint: string
  status: 'pending' | 'approved' | 'revoked'
}
export type FarmsPage = {
  ok: true
  farms: { farmId: string }[]
  nextAfter: string | null
}
export type ConnectorsPage = {
  ok: true
  connectors: InventoryConnector[]
  nextAfter: string | null
}

/** Fresh authorization and bounded reads share the account -> session -> membership transaction. */
export class PostgresConnectorInventory {
  constructor(
    private readonly sql: Sql,
    private readonly clock: () => number = Date.now,
  ) {}

  private valid(input: InventoryPageInput): boolean {
    return (
      /^[A-Za-z0-9_-]{1,128}$/.test(input.sessionRecordId) &&
      Number.isInteger(input.limit) &&
      input.limit >= 1 &&
      input.limit <= 50 &&
      (input.after === null || inventoryUuid.test(input.after)) &&
      Number.isSafeInteger(input.policy.idleTimeoutMs) &&
      input.policy.idleTimeoutMs > 0
    )
  }

  private async read(
    input: InventoryPageInput,
    page: (
      tx: TransactionSql,
      accountId: string,
    ) => Promise<FarmsPage | ConnectorsPage | InventoryFailure>,
  ): Promise<FarmsPage | ConnectorsPage | InventoryFailure> {
    if (!this.valid(input)) return { ok: false, reason: 'invalid-input' }
    try {
      return await this.sql.begin(
        async (tx): Promise<FarmsPage | ConnectorsPage | InventoryFailure> => {
          await tx`SET LOCAL statement_timeout = '2000ms'`
          await tx`SET LOCAL lock_timeout = '1000ms'`
          const accounts = await tx<
            AccountSessionState[]
          >`SELECT id, session_version::float8 AS "sessionVersion", disabled FROM farm.session_accounts WHERE id = (SELECT account_id FROM farm.account_sessions WHERE id = ${input.sessionRecordId}) FOR SHARE`
          const sessions = await tx<
            SessionRecord[]
          >`SELECT id, account_id AS "accountId", account_version::float8 AS "accountVersion", created_at::float8 AS "createdAt", last_seen_at::float8 AS "lastSeenAt", absolute_expires_at::float8 AS "absoluteExpiresAt", revoked_at::float8 AS "revokedAt" FROM farm.account_sessions WHERE id = ${input.sessionRecordId} FOR UPDATE`
          const account = accounts[0] ?? null
          const session = sessions[0] ?? null
          const initialNow = this.clock()
          const initial = evaluateSession(
            input.sessionRecordId,
            session,
            account,
            initialNow,
            input.policy,
          )
          if (!initial.ok) return { ok: false, reason: 'unauthorized' }
          const result = await page(tx, initial.accountId)
          if (!result.ok) return result
          const now = this.clock()
          const current = evaluateSession(
            input.sessionRecordId,
            session,
            account,
            now,
            input.policy,
          )
          if (now < initialNow || !current.ok)
            return { ok: false, reason: 'unauthorized' }
          await tx`UPDATE farm.account_sessions SET last_seen_at = ${current.touchAt} WHERE id = ${input.sessionRecordId}`
          return result
        },
      )
    } catch {
      return { ok: false, reason: 'storage-unavailable' }
    }
  }

  async listFarms(
    input: InventoryPageInput,
  ): Promise<FarmsPage | InventoryFailure> {
    const result = await this.read(input, async (tx, accountId) => {
      const rows = await tx<
        { farmId: string; revoked_at: number | null }[]
      >`SELECT farm_id AS "farmId", revoked_at FROM farm.memberships WHERE account_id = ${accountId} AND revoked_at IS NULL AND (${input.after}::uuid IS NULL OR farm_id > ${input.after}::uuid) ORDER BY farm_id LIMIT ${input.limit + 1} FOR SHARE`
      // PostgreSQL rechecks the predicate after waiting for each row lock.
      if (rows.some((row) => row.revoked_at !== null))
        return { ok: false, reason: 'forbidden' }
      const farms = rows
        .slice(0, input.limit)
        .map((row) => ({ farmId: row.farmId }))
      return {
        ok: true,
        farms,
        nextAfter:
          rows.length > input.limit ? (farms.at(-1)?.farmId ?? null) : null,
      }
    })
    if (!result.ok || 'farms' in result) return result
    return { ok: false, reason: 'storage-unavailable' }
  }

  async listConnectors(
    input: InventoryPageInput & { farmId: string },
  ): Promise<ConnectorsPage | InventoryFailure> {
    if (!inventoryUuid.test(input.farmId))
      return { ok: false, reason: 'invalid-input' }
    const result = await this.read(input, async (tx, accountId) => {
      const members = await tx<
        { revoked_at: number | null }[]
      >`SELECT revoked_at FROM farm.memberships WHERE farm_id = ${input.farmId}::uuid AND account_id = ${accountId} FOR SHARE`
      if (!members[0] || members[0].revoked_at !== null)
        return { ok: false, reason: 'forbidden' }
      const rows = await tx<
        InventoryConnector[]
      >`SELECT agent_id AS "agentId", fingerprint, status FROM farm.connector_enrollments WHERE farm_id = ${input.farmId}::uuid AND (${input.after}::uuid IS NULL OR agent_id > ${input.after}::uuid) ORDER BY agent_id LIMIT ${input.limit + 1}`
      const connectors = rows.slice(0, input.limit)
      return {
        ok: true,
        connectors,
        nextAfter:
          rows.length > input.limit
            ? (connectors.at(-1)?.agentId ?? null)
            : null,
      }
    })
    if (!result.ok || 'connectors' in result) return result
    return { ok: false, reason: 'storage-unavailable' }
  }
}
