import { randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'
import {
  PrinterState,
  PairingApprovalRequest,
} from '@open3dfarmmanager/farm-protocol'
import {
  evaluateSession,
  type SessionPolicy,
  type SessionRecord,
  type AccountSessionState,
} from '../utils/auth/session-contract.ts'

export function validPrinterOwnershipKey(value: unknown): value is string {
  if (
    !PrinterState.shape.printerKey.safeParse(value).success ||
    typeof value !== 'string' ||
    value.includes('\0')
  )
    return false
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
    value,
  )
}
export interface PrinterOwnershipRequest {
  sessionRecordId: string
  policy: SessionPolicy
  farmId: string
  agentId: string
  printerKey: string
}
export type PrinterOwnershipDecision =
  | { ok: true; assignmentId: string; status: 'active' | 'revoked' }
  | {
      ok: false
      reason: 'invalid-input' | 'denied' | 'conflict' | 'storage-unavailable'
    }
class AuthorizationExpired extends Error {
  readonly observedAt: number
  readonly expired: boolean
  constructor(
    observedAt: number,
    expired: boolean,
  ) {
    super('Authorization expired')
    this.observedAt = observedAt
    this.expired = expired
  }
}
/** Explicit owner/admin provisioning; not a transport authorization or printer discovery API. */
export class PostgresPrinterOwnership {
  private inflight = 0
  private readonly sql: Sql
  private readonly clock: () => number
  constructor(
    sql: Sql,
    clock: () => number = Date.now,
  ) {
    this.sql = sql
    this.clock = clock
  }
  private now(): number {
    const now = this.clock()
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid clock')
    return now
  }
  register(input: PrinterOwnershipRequest): Promise<PrinterOwnershipDecision> {
    return this.change(input, false)
  }
  revoke(
    input: PrinterOwnershipRequest & { expectedAssignmentId: string },
  ): Promise<PrinterOwnershipDecision> {
    return this.change(input, true, input.expectedAssignmentId)
  }
  private async change(
    input: PrinterOwnershipRequest,
    revoke: boolean,
    expectedAssignmentId?: string,
  ): Promise<PrinterOwnershipDecision> {
    if (
      !input ||
      (revoke &&
        !PairingApprovalRequest.shape.farm_id.safeParse(expectedAssignmentId)
          .success) ||
      !PairingApprovalRequest.shape.farm_id.safeParse(input.farmId).success ||
      !PairingApprovalRequest.shape.farm_id.safeParse(input.agentId).success ||
      !validPrinterOwnershipKey(input.printerKey)
    )
      return { ok: false, reason: 'invalid-input' }
    const initial = evaluateSession(
      input.sessionRecordId,
      null,
      null,
      0,
      input.policy,
    )
    if (!initial.ok && initial.reason === 'invalid-state')
      return { ok: false, reason: 'invalid-input' }
    if (this.inflight >= 32) return { ok: false, reason: 'storage-unavailable' }
    const { sessionRecordId, farmId, agentId, printerKey } = input
    const policy = { ...input.policy }
    this.inflight++
    try {
      return await this.sql.begin(
        async (tx): Promise<PrinterOwnershipDecision> => {
          await tx`SET LOCAL statement_timeout = '2000ms'`
          await tx`SET LOCAL lock_timeout = '1000ms'`
          const accounts = await tx<
            AccountSessionState[]
          >`SELECT id, session_version::float8 AS "sessionVersion", disabled FROM farm.session_accounts WHERE id = (SELECT account_id FROM farm.account_sessions WHERE id = ${sessionRecordId}) FOR UPDATE`
          const sessions = await tx<
            SessionRecord[]
          >`SELECT id, account_id AS "accountId", account_version::float8 AS "accountVersion", created_at::float8 AS "createdAt", last_seen_at::float8 AS "lastSeenAt", absolute_expires_at::float8 AS "absoluteExpiresAt", revoked_at::float8 AS "revokedAt" FROM farm.account_sessions WHERE id = ${sessionRecordId} FOR UPDATE`
          const firstAt = this.now()
          const first = evaluateSession(
            sessionRecordId,
            sessions[0] ?? null,
            accounts[0] ?? null,
            firstAt,
            policy,
          )
          if (!first.ok) {
            if (first.reason === 'expired')
              await tx`UPDATE farm.account_sessions SET revoked_at = ${firstAt} WHERE id = ${sessionRecordId}`
            return { ok: false, reason: 'denied' }
          }
          const membership =
            await tx`SELECT role, revoked_at FROM farm.memberships WHERE farm_id = ${farmId}::uuid AND account_id = ${first.accountId} FOR SHARE`
          if (
            !membership[0] ||
            membership[0].revoked_at !== null ||
            !['owner', 'admin'].includes(membership[0].role)
          )
            return { ok: false, reason: 'denied' }
          const enrollment =
            await tx`SELECT status FROM farm.connector_enrollments WHERE agent_id = ${agentId}::uuid AND farm_id = ${farmId}::uuid FOR UPDATE`
          if (
            !enrollment[0] ||
            (!revoke && enrollment[0].status !== 'approved')
          )
            return { ok: false, reason: 'denied' }
          const existing =
            await tx`SELECT id, revoked_at FROM farm.printer_assignments WHERE farm_id = ${farmId}::uuid AND agent_id = ${agentId}::uuid AND printer_key = ${printerKey} AND ((${revoke} AND id = ${expectedAssignmentId ?? null}::uuid) OR (NOT ${revoke} AND revoked_at IS NULL)) FOR UPDATE`
          const now = this.now()
          const current = evaluateSession(
            sessionRecordId,
            sessions[0] ?? null,
            accounts[0] ?? null,
            now,
            policy,
          )
          if (now < firstAt || !current.ok) {
            if (!current.ok && current.reason === 'expired' && now >= firstAt)
              await tx`UPDATE farm.account_sessions SET revoked_at = ${now} WHERE id = ${sessionRecordId}`
            return { ok: false, reason: 'denied' }
          }
          if (revoke && !existing[0]) return { ok: false, reason: 'denied' }
          if (revoke && existing[0]?.revoked_at !== null) {
            await tx`UPDATE farm.account_sessions SET last_seen_at = ${current.touchAt} WHERE id = ${sessionRecordId}`
            return {
              ok: true,
              assignmentId: String(existing[0]?.id),
              status: 'revoked',
            }
          }
          if (!revoke && existing[0]) return { ok: false, reason: 'conflict' }
          if (!revoke) {
            const count =
              await tx`SELECT count(*)::int AS count FROM farm.printer_assignments WHERE agent_id = ${agentId}::uuid AND revoked_at IS NULL`
            if (Number(count[0]?.count) >= 1000)
              return { ok: false, reason: 'denied' }
          }
          const id: string = revoke ? String(existing[0]?.id) : randomUUID()
          try {
            const touchAt = await tx.savepoint(async (save) => {
              if (revoke)
                await save`UPDATE farm.printer_assignments SET revoked_at = ${now}, revoked_by = ${current.accountId} WHERE id = ${id}::uuid`
              else
                await save`INSERT INTO farm.printer_assignments (id, farm_id, agent_id, printer_key, created_at, created_by) VALUES (${id}::uuid, ${farmId}::uuid, ${agentId}::uuid, ${printerKey}, ${now}, ${current.accountId})`
              const writtenAt = this.now()
              const after = evaluateSession(
                sessionRecordId,
                sessions[0] ?? null,
                accounts[0] ?? null,
                writtenAt,
                policy,
              )
              if (writtenAt < now || !after.ok)
                throw new AuthorizationExpired(
                  writtenAt,
                  !after.ok && after.reason === 'expired',
                )
              return after.touchAt
            })
            await tx`UPDATE farm.account_sessions SET last_seen_at = ${touchAt} WHERE id = ${sessionRecordId}`
            return {
              ok: true,
              assignmentId: id,
              status: revoke ? 'revoked' : 'active',
            }
          } catch (error) {
            if (error instanceof AuthorizationExpired) {
              if (error.expired && error.observedAt >= now)
                await tx`UPDATE farm.account_sessions SET revoked_at = ${error.observedAt} WHERE id = ${sessionRecordId}`
              return { ok: false, reason: 'denied' }
            }
            if (
              error &&
              typeof error === 'object' &&
              'code' in error &&
              error.code === '23505'
            )
              return { ok: false, reason: 'conflict' }
            throw error
          }
        },
      )
    } catch {
      return { ok: false, reason: 'storage-unavailable' }
    } finally {
      this.inflight--
    }
  }
}
