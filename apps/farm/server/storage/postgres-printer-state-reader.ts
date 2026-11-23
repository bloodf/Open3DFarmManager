import type { Sql } from 'postgres'
import {
  evaluateSession,
  type AccountSessionState,
  type SessionPolicy,
  type SessionRecord,
} from '../utils/auth/session-contract.ts'
import { inventoryUuid } from './postgres-connector-inventory.ts'
import {
  parseStoredPrinterState,
  type PrinterStateRow,
  type PrinterStatesFailure,
} from '../services/printer-states-core.ts'

export interface PrinterStateListInput {
  sessionRecordId: string
  policy: SessionPolicy
  farmId: string
}

interface RawRow {
  assignmentId: string
  printerKey: string
  displayName?: string | null
  groupName?: string | null
  location?: string | null
  sortOrder?: number | null
  state: unknown
}

/**
 * Read-only projection of the latest known printer state per active
 * assignment. The session and membership checks mirror the printer inventory
 * exactly: the same session evaluation, the same membership row and the same
 * denial for a non-member.
 */
export class PostgresPrinterStateReader {
  private inflight = 0
  private readonly sql: Sql
  private readonly clock: () => number

  constructor(sql: Sql, clock: () => number = Date.now) {
    this.sql = sql
    this.clock = clock
  }

  async list(
    input: PrinterStateListInput,
  ): Promise<{ ok: true; states: PrinterStateRow[] } | PrinterStatesFailure> {
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
          await tx`SELECT revoked_at FROM farm.memberships WHERE farm_id = ${input.farmId}::uuid AND account_id = ${first.accountId} FOR SHARE`
        if (!members[0] || members[0].revoked_at !== null)
          return { ok: false as const, reason: 'forbidden' as const }
        const rows = await tx<
          RawRow[]
        >`SELECT a.id AS "assignmentId", a.printer_key AS "printerKey", a.display_name AS "displayName", a.group_name AS "groupName", a.location AS "location", a.sort_order AS "sortOrder", s.state
          FROM farm.printer_assignments a
          JOIN farm.printer_latest_state s
            ON s.farm_id = a.farm_id AND s.agent_id = a.agent_id AND s.printer_key = a.printer_key
          WHERE a.farm_id = ${input.farmId}::uuid AND a.revoked_at IS NULL
          ORDER BY a.id`
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
        const states: PrinterStateRow[] = []
        for (const { state, ...assignment } of rows) {
          const stored = parseStoredPrinterState(state)
          if (!stored) continue
          states.push({
            ...assignment,
            state: stored.state,
            ...(stored.alarms !== undefined && { alarms: stored.alarms }),
            progress: stored.progress,
            toolTemperatureCelsius: stored.toolTemperatureCelsius,
            bedTemperatureCelsius: stored.bedTemperatureCelsius,
            observedAt: stored.observedAt,
          })
        }
        return { ok: true as const, states }
      })
    } catch {
      return { ok: false, reason: 'storage-unavailable' }
    } finally {
      this.inflight--
    }
  }
}
