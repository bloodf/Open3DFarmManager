import type { Sql, TransactionSql } from 'postgres'
import type { ApiEnvelopeAction } from '../../../../packages/farm-protocol/src/api-envelope.ts'
import {
  APPROVER_ROLES,
  type ApprovalKind,
  type DecideOutcome,
  type HeldItem,
  type IntegrationApprovalStore,
} from '../services/integration-approval.ts'
import { HELD_TTL_MS } from '../services/integration-jobs.ts'

const validTime = (value: number) => Number.isSafeInteger(value) && value >= 0

interface HeldRow {
  id: string
  farmId: string
  appId: string
  appName: string
  grantId: string
  printerAssignmentId: string
  printerKey: string
  agentId: string
  createdAt: number
  status: string
  // Job columns.
  fileUrl?: string
  sha256?: string
  sizeBytes?: number
  displayName?: string
  // Action column.
  action?: ApiEnvelopeAction
}

const table = (kind: ApprovalKind) =>
  kind === 'job' ? 'farm.integration_jobs' : 'farm.integration_actions'

function toItem(kind: ApprovalKind, row: HeldRow): HeldItem {
  const base = {
    id: row.id,
    farmId: row.farmId,
    appId: row.appId,
    appName: row.appName,
    grantId: row.grantId,
    printerAssignmentId: row.printerAssignmentId,
    printerKey: row.printerKey,
    agentId: row.agentId,
    createdAt: row.createdAt,
    expiresAt: row.createdAt + HELD_TTL_MS,
  }
  if (kind === 'job')
    return {
      ...base,
      kind,
      summary: row.displayName!,
      command: {
        kind: 'job',
        job: {
          file_url: row.fileUrl!,
          sha256: row.sha256!,
          size_bytes: row.sizeBytes!,
          display_name: row.displayName!,
        },
      },
    }
  return {
    ...base,
    kind,
    summary: row.action!.action,
    command: { kind: 'action', action: row.action! },
  }
}

/** The farm_integration_approvals role is the least-privilege caller. */
export class PostgresIntegrationApprovals implements IntegrationApprovalStore {
  private readonly sql: Sql
  constructor(sql: Sql) {
    this.sql = sql
  }

  private async mayDecide(
    sql: Sql | TransactionSql,
    accountId: string,
    farmId: string,
  ) {
    const rows = await sql`
      SELECT 1 FROM farm.memberships
      WHERE farm_id = ${farmId}::uuid AND account_id = ${accountId}
        AND role = ANY (${[...APPROVER_ROLES]}::text[]) AND revoked_at IS NULL`
    return rows.length > 0
  }

  private rows(
    sql: Sql | TransactionSql,
    kind: ApprovalKind,
    farmId: string,
    now: number,
    limit: number,
  ) {
    const extra =
      kind === 'job'
        ? sql`x.file_url AS "fileUrl", x.sha256, x.size_bytes::float8 AS "sizeBytes", x.display_name AS "displayName"`
        : sql`x.action`
    return sql<HeldRow[]>`
      SELECT x.id::text AS id, x.farm_id::text AS "farmId", x.app_id::text AS "appId", a.name AS "appName",
        x.grant_id::text AS "grantId", x.printer_assignment_id::text AS "printerAssignmentId",
        p.printer_key AS "printerKey", p.agent_id::text AS "agentId", x.created_at::float8 AS "createdAt",
        x.status, ${extra}
      FROM ${sql(table(kind))} x
      JOIN farm.integration_apps a ON a.id = x.app_id
      JOIN farm.printer_assignments p ON p.id = x.printer_assignment_id
      WHERE x.farm_id = ${farmId}::uuid AND x.status = 'held' AND x.created_at + ${HELD_TTL_MS} > ${now}
      ORDER BY x.created_at, x.id LIMIT ${limit}`
  }

  async list(
    accountId: string,
    farmId: string,
    now: number,
    limit: number,
  ): Promise<HeldItem[] | null> {
    if (!validTime(now)) throw new Error('Invalid time')
    const bound = Math.max(1, Math.min(Math.trunc(limit), 100))
    return await this.sql.begin(async (tx) => {
      if (!(await this.mayDecide(tx, accountId, farmId))) return null
      const [jobs, actions] = await Promise.all([
        this.rows(tx, 'job', farmId, now, bound),
        this.rows(tx, 'action', farmId, now, bound),
      ])
      return [
        ...jobs.map((row) => toItem('job', row)),
        ...actions.map((row) => toItem('action', row)),
      ]
        .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
        .slice(0, bound)
    })
  }

  private async audit(
    tx: TransactionSql,
    kind: ApprovalKind,
    row: HeldRow,
    actor: { kind: 'owner' | 'system'; id: string | null },
    outcome: 'approved' | 'rejected',
    decision: string,
    now: number,
  ) {
    await tx`
      INSERT INTO farm.integration_audit (farm_id, app_id, printer_assignment_id, actor_kind, actor_id, action, resource_type, resource_id, outcome, occurred_at, details)
      VALUES (${row.farmId}::uuid, ${row.appId}::uuid, ${row.printerAssignmentId}::uuid, ${actor.kind}, ${actor.id}, 'approval.decided', ${kind}, ${row.id}, ${outcome}, ${now}, ${tx.json({ approvalDecision: decision })})`
  }

  async decide(input: {
    accountId: string
    farmId: string
    id: string
    decision: 'approve' | 'reject'
    now: number
  }): Promise<DecideOutcome> {
    if (!validTime(input.now)) throw new Error('Invalid time')
    const { now } = input
    return await this.sql.begin(async (tx): Promise<DecideOutcome> => {
      await tx`SET LOCAL statement_timeout = '2000ms'`
      await tx`SET LOCAL lock_timeout = '1000ms'`
      if (!(await this.mayDecide(tx, input.accountId, input.farmId)))
        return { kind: 'forbidden' }
      for (const kind of ['job', 'action'] as const) {
        const extra =
          kind === 'job'
            ? tx`x.file_url AS "fileUrl", x.sha256, x.size_bytes::float8 AS "sizeBytes", x.display_name AS "displayName"`
            : tx`x.action`
        const found = await tx<HeldRow[]>`
          SELECT x.id::text AS id, x.farm_id::text AS "farmId", x.app_id::text AS "appId", a.name AS "appName",
            x.grant_id::text AS "grantId", x.printer_assignment_id::text AS "printerAssignmentId",
            p.printer_key AS "printerKey", p.agent_id::text AS "agentId", x.created_at::float8 AS "createdAt",
            x.status, ${extra}
          FROM ${tx(table(kind))} x
          JOIN farm.integration_apps a ON a.id = x.app_id
          JOIN farm.printer_assignments p ON p.id = x.printer_assignment_id
          WHERE x.id = ${input.id}::uuid AND x.farm_id = ${input.farmId}::uuid
          FOR UPDATE OF x`
        const row = found[0]
        if (!row) continue
        // Locked: a concurrent decision waits here and then sees a settled status.
        if (row.status !== 'held') return { kind: 'conflict' }
        const item = toItem(kind, row)
        const settle = async (status: 'submitted' | 'rejected' | 'expired') => {
          const updated = await tx`
            UPDATE ${tx(table(kind))} SET status = ${status}, updated_at = GREATEST(${now}, updated_at)
            WHERE id = ${row.id}::uuid AND status = 'held'`
          if (updated.count !== 1) throw new Error('Held item changed')
        }
        if (now >= row.createdAt + HELD_TTL_MS) {
          await settle('expired')
          await this.audit(
            tx,
            kind,
            row,
            { kind: 'system', id: null },
            'rejected',
            'expired',
            now,
          )
          return { kind: 'expired', item }
        }
        if (input.decision === 'reject') {
          await settle('rejected')
          await this.audit(
            tx,
            kind,
            row,
            { kind: 'owner', id: input.accountId },
            'rejected',
            'rejected',
            now,
          )
          return { kind: 'decided', item, decision: 'reject' }
        }
        const authority = await tx`
          SELECT 1 FROM farm.integration_app_grants g
          JOIN farm.integration_apps a ON a.id = g.app_id
          JOIN farm.printer_assignments p ON p.id = ${row.printerAssignmentId}::uuid
          JOIN farm.farms f ON f.id = g.farm_id
          WHERE g.id = ${row.grantId}::uuid AND g.app_id = ${row.appId}::uuid AND g.farm_id = ${row.farmId}::uuid
            AND g.disabled_at IS NULL AND a.revoked_at IS NULL AND p.revoked_at IS NULL
            AND (g.printer_assignment_id IS NULL OR g.printer_assignment_id = p.id)
            AND (NOT a.sandbox OR f.sandbox)`
        if (authority.length === 0) {
          await settle('rejected')
          await this.audit(
            tx,
            kind,
            row,
            { kind: 'owner', id: input.accountId },
            'rejected',
            'authority-lost',
            now,
          )
          return { kind: 'authority-lost', item }
        }
        await settle('submitted')
        await this.audit(
          tx,
          kind,
          row,
          { kind: 'owner', id: input.accountId },
          'approved',
          'approved',
          now,
        )
        return { kind: 'decided', item, decision: 'approve' }
      }
      return { kind: 'not-found' }
    })
  }

  async expireHeld(now: number, limit: number): Promise<number> {
    if (!validTime(now)) throw new Error('Invalid time')
    const bound = Math.max(1, Math.min(Math.trunc(limit), 500))
    return await this.sql.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout = '2000ms'`
      await tx`SET LOCAL lock_timeout = '1000ms'`
      let total = 0
      for (const kind of ['job', 'action'] as const) {
        const expired = await tx<
          {
            id: string
            farmId: string
            appId: string
            printerAssignmentId: string
          }[]
        >`
          UPDATE ${tx(table(kind))} x SET status = 'expired', updated_at = GREATEST(${now}, x.updated_at)
          WHERE x.id IN (
            SELECT h.id FROM ${tx(table(kind))} h
            WHERE h.status = 'held' AND h.created_at + ${HELD_TTL_MS} <= ${now}
            ORDER BY h.created_at LIMIT ${bound} FOR UPDATE SKIP LOCKED)
          RETURNING x.id::text AS id, x.farm_id::text AS "farmId", x.app_id::text AS "appId", x.printer_assignment_id::text AS "printerAssignmentId"`
        for (const row of expired)
          await this.audit(
            tx,
            kind,
            row as HeldRow,
            { kind: 'system', id: null },
            'rejected',
            'expired',
            now,
          )
        total += expired.length
      }
      return total
    })
  }
}
