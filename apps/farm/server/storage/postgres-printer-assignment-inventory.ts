import type { Sql } from 'postgres'
import {
  evaluateSession,
  type SessionPolicy,
  type SessionRecord,
  type AccountSessionState,
} from '../utils/auth/session-contract.ts'
import {
  inventoryUuid,
  type InventoryFailure,
} from './postgres-connector-inventory.ts'
export interface PrinterAssignmentRow {
  assignmentId: string
  agentId: string
  printerKey: string
  status: 'active' | 'revoked'
  connectorStatus: 'pending' | 'approved' | 'revoked'
}
export class PostgresPrinterAssignmentInventory {
  private inflight = 0
  constructor(
    private readonly sql: Sql,
    private readonly clock: () => number = Date.now,
  ) {}
  async list(input: {
    sessionRecordId: string
    policy: SessionPolicy
    farmId: string
    limit: number
    after: string | null
  }): Promise<
    | {
        ok: true
        printers: PrinterAssignmentRow[]
        nextAfter: string | null
        canManage: boolean
      }
    | InventoryFailure
  > {
    if (
      !inventoryUuid.test(input.farmId) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.sessionRecordId) ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 50 ||
      (input.after !== null && !inventoryUuid.test(input.after)) ||
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
        const rows = await tx<
          PrinterAssignmentRow[]
        >`SELECT p.id AS "assignmentId", p.agent_id AS "agentId", p.printer_key AS "printerKey", CASE WHEN p.revoked_at IS NULL THEN 'active' ELSE 'revoked' END AS status, e.status AS "connectorStatus" FROM farm.printer_assignments p JOIN farm.connector_enrollments e ON e.agent_id=p.agent_id AND e.farm_id=p.farm_id WHERE p.farm_id=${input.farmId}::uuid AND (${input.after}::uuid IS NULL OR p.id>${input.after}::uuid) ORDER BY p.id LIMIT ${input.limit + 1}`
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
        const printers = rows.slice(0, input.limit)
        return {
          ok: true as const,
          printers,
          nextAfter:
            rows.length > input.limit
              ? (printers.at(-1)?.assignmentId ?? null)
              : null,
          canManage: ['owner', 'admin'].includes(members[0].role),
        }
      })
    } catch {
      return { ok: false, reason: 'storage-unavailable' }
    } finally {
      this.inflight--
    }
  }
}
