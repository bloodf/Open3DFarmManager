import type { Sql } from 'postgres'
import {
  evaluateSession,
  type SessionPolicy,
  type SessionRecord,
  type AccountSessionState,
} from '../utils/auth/session-contract.ts'

export interface EnrollmentApproval {
  sessionRecordId: string
  farmId: string
  agentId: string
  expectedFingerprint: string
  now: number
  policy: SessionPolicy
}
export type EnrollmentApprovalDecision =
  | { ok: true; accountId: string; status: 'approved' }
  | { ok: false; reason: 'denied' | 'invalid-input' | 'storage-unavailable' }

const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)

/** Internal approval only. No bearer credentials, HTTP endpoint or printer commands. */
export class PostgresFarmAuthorization {
  private readonly sql: Sql
  constructor(sql: Sql) {
    this.sql = sql
  }
  async approve(
    input: EnrollmentApproval,
  ): Promise<EnrollmentApprovalDecision> {
    const {
      sessionRecordId,
      farmId,
      agentId,
      expectedFingerprint,
      now,
      policy,
    } = input
    const initial = evaluateSession(sessionRecordId, null, null, now, policy)
    if (
      (!initial.ok && initial.reason === 'invalid-state') ||
      !uuid(farmId) ||
      !uuid(agentId) ||
      typeof expectedFingerprint !== 'string' ||
      !/^SHA256:[A-Za-z0-9_-]{43}$/.test(expectedFingerprint)
    )
      return { ok: false, reason: 'invalid-input' }
    try {
      return await this.sql.begin(
        async (tx): Promise<EnrollmentApprovalDecision> => {
          await tx`SET LOCAL statement_timeout = '2000ms'`
          await tx`SET LOCAL lock_timeout = '1000ms'`
          const accounts = await tx<
            AccountSessionState[]
          >`SELECT id, session_version::float8 AS "sessionVersion", disabled FROM farm.session_accounts
          WHERE id = (SELECT account_id FROM farm.account_sessions WHERE id = ${sessionRecordId}) FOR UPDATE`
          const sessions = await tx<
            SessionRecord[]
          >`SELECT id, account_id AS "accountId", account_version::float8 AS "accountVersion", created_at::float8 AS "createdAt", last_seen_at::float8 AS "lastSeenAt", absolute_expires_at::float8 AS "absoluteExpiresAt", revoked_at::float8 AS "revokedAt"
          FROM farm.account_sessions WHERE id = ${sessionRecordId} FOR UPDATE`
          const decision = evaluateSession(
            sessionRecordId,
            sessions[0] ?? null,
            accounts[0] ?? null,
            now,
            policy,
          )
          if (!decision.ok) {
            if (decision.reason === 'expired')
              await tx`UPDATE farm.account_sessions SET revoked_at = ${now} WHERE id = ${sessionRecordId}`
            return {
              ok: false,
              reason: 'denied',
            } satisfies EnrollmentApprovalDecision
          }
          const memberships =
            await tx`SELECT role, revoked_at FROM farm.memberships WHERE farm_id = ${farmId}::uuid AND account_id = ${decision.accountId} FOR SHARE`
          const member = memberships[0]
          if (
            !member ||
            member.revoked_at !== null ||
            !['owner', 'admin'].includes(member.role)
          )
            return {
              ok: false,
              reason: 'denied',
            } satisfies EnrollmentApprovalDecision
          const enrollments =
            await tx`SELECT status, fingerprint FROM farm.connector_enrollments WHERE farm_id = ${farmId}::uuid AND agent_id = ${agentId}::uuid FOR UPDATE`
          const enrollment = enrollments[0]
          if (
            !enrollment ||
            enrollment.fingerprint !== expectedFingerprint ||
            !['pending', 'approved'].includes(enrollment.status)
          )
            return {
              ok: false,
              reason: 'denied',
            } satisfies EnrollmentApprovalDecision
          if (enrollment.status === 'pending')
            await tx`UPDATE farm.connector_enrollments SET status = 'approved' WHERE farm_id = ${farmId}::uuid AND agent_id = ${agentId}::uuid`
          await tx`UPDATE farm.account_sessions SET last_seen_at = ${decision.touchAt} WHERE id = ${sessionRecordId}`
          return {
            ok: true,
            accountId: decision.accountId,
            status: 'approved',
          } satisfies EnrollmentApprovalDecision
        },
      )
    } catch {
      return { ok: false, reason: 'storage-unavailable' }
    }
  }
}
