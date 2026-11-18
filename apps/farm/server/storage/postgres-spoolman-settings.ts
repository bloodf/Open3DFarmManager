import type { Sql } from 'postgres'
import {
  evaluateSession,
  type SessionPolicy,
  type SessionRecord,
  type AccountSessionState,
} from '../utils/auth/session-contract.ts'
import { inventoryUuid } from './postgres-connector-inventory.ts'

export type SpoolmanFailure = {
  ok: false
  reason:
    | 'invalid-input'
    | 'unauthorized'
    | 'forbidden'
    | 'denied'
    | 'storage-unavailable'
}

export type SpoolmanStatus = 'reachable' | 'unreachable' | 'unauthorized'
export interface SpoolmanConnectorSetting {
  agentId: string
  origin: string
  status: SpoolmanStatus
  configured: boolean
  checkedAt: number
}
type Authority = {
  sessionRecordId: string
  policy: SessionPolicy
  farmId: string
}
export interface SpoolmanSettingsStore {
  list(
    input: Authority,
  ): Promise<
    | { ok: true; settings: SpoolmanConnectorSetting[]; canManage: boolean }
    | SpoolmanFailure
  >
  save(
    input: Authority & {
      agentId: string
      origin: string
      status: SpoolmanStatus
      configured: boolean
    },
  ): Promise<{ ok: true; setting: SpoolmanConnectorSetting } | SpoolmanFailure>
}

/**
 * Non-secret farm setting: origin and test status per Connector. The table has
 * no credential column; a Spoolman credential only ever reaches the Connector.
 */
export class PostgresSpoolmanSettings implements SpoolmanSettingsStore {
  private inflight = 0
  private readonly sql: Sql
  private readonly clock: () => number

  constructor(sql: Sql, clock: () => number = Date.now) {
    this.sql = sql
    this.clock = clock
  }

  private async scoped<T>(
    input: Authority,
    action: (
      tx: Sql,
      member: { role: string },
      accountId: string,
      now: number,
    ) => Promise<T | SpoolmanFailure>,
  ): Promise<T | SpoolmanFailure> {
    if (
      !inventoryUuid.test(input.farmId) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.sessionRecordId) ||
      !Number.isSafeInteger(input.policy.idleTimeoutMs) ||
      input.policy.idleTimeoutMs <= 0
    )
      return { ok: false, reason: 'invalid-input' }
    if (this.inflight >= 32) return { ok: false, reason: 'storage-unavailable' }
    this.inflight++
    try {
      return await this.sql.begin(async (tx) => {
        await tx`SET LOCAL statement_timeout = '2000ms'`
        await tx`SET LOCAL lock_timeout = '1000ms'`
        const accounts = await tx<
          AccountSessionState[]
        >`SELECT id, session_version::float8 AS "sessionVersion", disabled FROM farm.session_accounts WHERE id = (SELECT account_id FROM farm.account_sessions WHERE id = ${input.sessionRecordId}) FOR SHARE`
        const sessions = await tx<
          SessionRecord[]
        >`SELECT id, account_id AS "accountId", account_version::float8 AS "accountVersion", created_at::float8 AS "createdAt", last_seen_at::float8 AS "lastSeenAt", absolute_expires_at::float8 AS "absoluteExpiresAt", revoked_at::float8 AS "revokedAt" FROM farm.account_sessions WHERE id = ${input.sessionRecordId} FOR UPDATE`
        const firstAt = this.clock()
        const first = evaluateSession(
          input.sessionRecordId,
          sessions[0] ?? null,
          accounts[0] ?? null,
          firstAt,
          input.policy,
        )
        if (!first.ok)
          return { ok: false as const, reason: 'unauthorized' as const }
        const members =
          await tx`SELECT role, revoked_at FROM farm.memberships WHERE farm_id = ${input.farmId}::uuid AND account_id = ${first.accountId} FOR SHARE`
        if (!members[0] || members[0].revoked_at !== null)
          return { ok: false as const, reason: 'forbidden' as const }
        const result = await action(
          tx as unknown as Sql,
          { role: String(members[0].role) },
          first.accountId,
          firstAt,
        )
        const now = this.clock()
        const current = evaluateSession(
          input.sessionRecordId,
          sessions[0] ?? null,
          accounts[0] ?? null,
          now,
          input.policy,
        )
        if (now < firstAt || !current.ok)
          return { ok: false as const, reason: 'unauthorized' as const }
        await tx`UPDATE farm.account_sessions SET last_seen_at=${current.touchAt} WHERE id=${input.sessionRecordId}`
        return result
      })
    } catch {
      return { ok: false, reason: 'storage-unavailable' }
    } finally {
      this.inflight--
    }
  }

  list(input: Authority) {
    return this.scoped<{
      ok: true
      settings: SpoolmanConnectorSetting[]
      canManage: boolean
    }>(input, async (tx, member) => {
      const rows = await tx<
        SpoolmanConnectorSetting[]
      >`SELECT agent_id AS "agentId", origin, status, configured, checked_at::float8 AS "checkedAt" FROM farm.spoolman_connector_settings WHERE farm_id=${input.farmId}::uuid ORDER BY agent_id LIMIT 50`
      return {
        ok: true as const,
        settings: rows.map((row) => ({ ...row })),
        canManage: ['owner', 'admin'].includes(member.role),
      }
    })
  }

  save(
    input: Authority & {
      agentId: string
      origin: string
      status: SpoolmanStatus
      configured: boolean
    },
  ) {
    if (!inventoryUuid.test(input.agentId))
      return Promise.resolve({ ok: false, reason: 'invalid-input' } as const)
    return this.scoped<{ ok: true; setting: SpoolmanConnectorSetting }>(
      input,
      async (tx, member, accountId, now) => {
        if (!['owner', 'admin'].includes(member.role))
          return { ok: false as const, reason: 'denied' as const }
        // The Connector must be an enrolled one of this farm.
        const enrolled =
          await tx`SELECT 1 FROM farm.connector_enrollments WHERE farm_id=${input.farmId}::uuid AND agent_id=${input.agentId}::uuid AND status='approved' FOR SHARE`
        if (!enrolled[0])
          return { ok: false as const, reason: 'forbidden' as const }
        // A failed test never replaces a Spoolman that is already applied.
        await tx`INSERT INTO farm.spoolman_connector_settings (farm_id, agent_id, origin, status, configured, checked_at, updated_by)
          VALUES (${input.farmId}::uuid, ${input.agentId}::uuid, ${input.origin}, ${input.status}, ${input.configured}, ${now}, ${accountId})
          ON CONFLICT (farm_id, agent_id) DO UPDATE SET origin=EXCLUDED.origin, status=EXCLUDED.status, configured=EXCLUDED.configured, checked_at=EXCLUDED.checked_at, updated_by=EXCLUDED.updated_by
          WHERE EXCLUDED.configured OR NOT farm.spoolman_connector_settings.configured`
        const stored = await tx<
          SpoolmanConnectorSetting[]
        >`SELECT agent_id AS "agentId", origin, status, configured, checked_at::float8 AS "checkedAt" FROM farm.spoolman_connector_settings WHERE farm_id=${input.farmId}::uuid AND agent_id=${input.agentId}::uuid`
        if (!stored[0])
          return { ok: false as const, reason: 'storage-unavailable' as const }
        return { ok: true as const, setting: { ...stored[0] } }
      },
    )
  }
}
