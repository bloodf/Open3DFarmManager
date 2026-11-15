import type { Sql, TransactionSql } from 'postgres'
import {
  evaluateSession,
  type AccountSessionState,
  type SessionPolicy,
  type SessionRecord,
} from '../utils/auth/session-contract.ts'
import { inventoryUuid } from './postgres-connector-inventory.ts'
import {
  canReadJobHistory,
  jobHistoryCursor,
  type JobHistoryFailure,
  type JobRecord,
} from '../services/job-history-core.ts'

export interface JobHistoryRow extends JobRecord {
  id: string
}
interface RawRow {
  id: string
  printerKey: string
  outcome: JobRecord['outcome']
  filename: string | null
  printDurationSeconds: number | null
  totalDurationSeconds: number | null
  endedAt: number
}

/** Same transaction as the telemetry event; the unique key makes repeats a no-op. */
export async function recordJobs(
  tx: TransactionSql,
  scope: { farmId: string; agentId: string },
  jobs: readonly JobRecord[],
): Promise<void> {
  for (const job of jobs)
    await tx`INSERT INTO farm.job_history (farm_id, agent_id, printer_key, outcome, filename, print_duration_seconds, total_duration_seconds, ended_at)
      VALUES (${scope.farmId}::uuid, ${scope.agentId}::uuid, ${job.printerKey}, ${job.outcome}, ${job.filename ?? null}, ${job.printDurationSeconds ?? null}, ${job.totalDurationSeconds ?? null}, ${job.endedAt})
      ON CONFLICT (farm_id, agent_id, printer_key, ended_at) DO NOTHING`
}

export interface JobHistoryListInput {
  sessionRecordId: string
  policy: SessionPolicy
  farmId: string
  printerKey: string | null
  limit: number
  before: string | null
}
export type JobHistoryListResult =
  | { ok: true; jobs: JobHistoryRow[]; nextBefore: string | null }
  | JobHistoryFailure

export class PostgresJobHistory {
  private inflight = 0
  constructor(
    private readonly sql: Sql,
    private readonly clock: () => number = Date.now,
  ) {}
  async list(input: JobHistoryListInput): Promise<JobHistoryListResult> {
    if (
      !inventoryUuid.test(input.farmId) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.sessionRecordId) ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 50 ||
      (input.before !== null && !jobHistoryCursor.test(input.before)) ||
      !Number.isSafeInteger(input.policy.idleTimeoutMs) ||
      input.policy.idleTimeoutMs <= 0
    )
      return { ok: false, reason: 'invalid-input' }
    if (this.inflight >= 32) return { ok: false, reason: 'storage-unavailable' }
    const [beforeEnd = null, beforeId = null] = input.before?.split('-') ?? []
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
        if (
          !members[0] ||
          members[0].revoked_at !== null ||
          !canReadJobHistory(members[0].role)
        )
          return { ok: false as const, reason: 'forbidden' as const }
        const rows = await tx<
          RawRow[]
        >`SELECT id::text AS id, printer_key AS "printerKey", outcome, filename, print_duration_seconds AS "printDurationSeconds", total_duration_seconds AS "totalDurationSeconds", ended_at::float8 AS "endedAt"
          FROM farm.job_history
          WHERE farm_id = ${input.farmId}::uuid
            AND (${input.printerKey}::text IS NULL OR printer_key = ${input.printerKey})
            AND (${beforeEnd}::bigint IS NULL OR (ended_at, id) < (${beforeEnd}::bigint, ${beforeId}::bigint))
          ORDER BY ended_at DESC, id DESC LIMIT ${input.limit + 1}`
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
        const jobs: JobHistoryRow[] = rows.slice(0, input.limit).map((row) => ({
          id: row.id,
          printerKey: row.printerKey,
          outcome: row.outcome,
          endedAt: row.endedAt,
          // Nullable columns are omitted from the API.
          ...(row.filename !== null ? { filename: row.filename } : {}),
          ...(row.printDurationSeconds !== null
            ? { printDurationSeconds: row.printDurationSeconds }
            : {}),
          ...(row.totalDurationSeconds !== null
            ? { totalDurationSeconds: row.totalDurationSeconds }
            : {}),
        }))
        const last = jobs.at(-1)
        return {
          ok: true as const,
          jobs,
          nextBefore:
            rows.length > input.limit && last
              ? `${last.endedAt}-${last.id}`
              : null,
        }
      })
    } catch {
      return { ok: false, reason: 'storage-unavailable' }
    } finally {
      this.inflight--
    }
  }
}
