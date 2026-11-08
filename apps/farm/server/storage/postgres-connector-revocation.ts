import { readRevocationCredentialRecords } from './postgres-connector-credential-record.ts'
import type { Sql } from 'postgres'
import { PairingApprovalRequest } from '@open3dfarmmanager/farm-protocol'
import {
  evaluateSession,
  type SessionPolicy,
  type SessionRecord,
  type AccountSessionState,
} from '../utils/auth/session-contract.ts'

export interface ConnectorRevocationRequest {
  sessionRecordId: string
  policy: SessionPolicy
  farmId: string
  agentId: string
  expectedFingerprint: string
}
export type ConnectorRevocationDecision =
  | {
      ok: true
      status: 'revoked'
      credential: 'not-issued' | 'revoked'
      revokedAt: number
    }
  | { ok: false; reason: 'invalid-input' | 'denied' | 'storage-unavailable' }
class RevocationAuthorizationExpired extends Error {
  readonly observedAt: number
  readonly sessionExpired: boolean
  constructor(observedAt: number, sessionExpired: boolean) {
    super('Revocation authorization is no longer current')
    this.observedAt = observedAt
    this.sessionExpired = sessionExpired
  }
}
interface Tombstone {
  farm_id: string
  fingerprint: string
  credential_jti: string | null
  revoked_at: number
}

/** Authorized terminal cleanup only. No JWT redelivery, pairing reset, networking or printer command. */
export class PostgresConnectorRevocation {
  private readonly sql: Sql
  private readonly clock: () => number
  constructor(sql: Sql, clock: () => number = Date.now) {
    this.sql = sql
    this.clock = clock
  }
  private now(): number {
    const now = this.clock()
    if (!Number.isSafeInteger(now) || now < 0)
      throw new Error('Invalid revocation clock')
    return now
  }
  async revoke(
    input: ConnectorRevocationRequest,
  ): Promise<ConnectorRevocationDecision> {
    if (
      !input ||
      !PairingApprovalRequest.shape.farm_id.safeParse(input.farmId).success ||
      !PairingApprovalRequest.shape.farm_id.safeParse(input.agentId).success ||
      !PairingApprovalRequest.shape.expected_fingerprint.safeParse(
        input.expectedFingerprint,
      ).success
    )
      return { ok: false, reason: 'invalid-input' }
    const validation = evaluateSession(
      input.sessionRecordId,
      null,
      null,
      0,
      input.policy,
    )
    if (!validation.ok && validation.reason === 'invalid-state')
      return { ok: false, reason: 'invalid-input' }
    // Snapshot actor and target before asynchronous work. Never accept codes as authority.
    const { sessionRecordId, farmId, agentId, expectedFingerprint } = input
    const policy = { ...input.policy }
    try {
      return await this.sql.begin(
        async (tx): Promise<ConnectorRevocationDecision> => {
          await tx`SET LOCAL statement_timeout = '2000ms'`
          await tx`SET LOCAL lock_timeout = '1000ms'`
          const accounts = await tx<
            AccountSessionState[]
          >`SELECT id, session_version::float8 AS "sessionVersion", disabled FROM farm.session_accounts WHERE id = (SELECT account_id FROM farm.account_sessions WHERE id = ${sessionRecordId}) FOR UPDATE`
          const sessions = await tx<
            SessionRecord[]
          >`SELECT id, account_id AS "accountId", account_version::float8 AS "accountVersion", created_at::float8 AS "createdAt", last_seen_at::float8 AS "lastSeenAt", absolute_expires_at::float8 AS "absoluteExpiresAt", revoked_at::float8 AS "revokedAt" FROM farm.account_sessions WHERE id = ${sessionRecordId} FOR UPDATE`
          const initialNow = this.now()
          const initial = evaluateSession(
            sessionRecordId,
            sessions[0] ?? null,
            accounts[0] ?? null,
            initialNow,
            policy,
          )
          if (!initial.ok) {
            if (initial.reason === 'expired')
              await tx`UPDATE farm.account_sessions SET revoked_at = ${initialNow} WHERE id = ${sessionRecordId}`
            return { ok: false, reason: 'denied' }
          }
          const members =
            await tx`SELECT role, revoked_at FROM farm.memberships WHERE farm_id = ${farmId}::uuid AND account_id = ${initial.accountId} FOR SHARE`
          if (
            !members[0] ||
            members[0].revoked_at !== null ||
            !['owner', 'admin'].includes(members[0].role)
          )
            return { ok: false, reason: 'denied' }
          // All claims hold the pairing lock before enrollment; absence supports legacy enrollment records.
          await tx`SELECT agent_id FROM farm.pairing_requests WHERE agent_id = ${agentId}::uuid AND farm_id = ${farmId}::uuid AND fingerprint = ${expectedFingerprint} FOR UPDATE`
          const enrollments =
            await tx`SELECT status FROM farm.connector_enrollments WHERE agent_id = ${agentId}::uuid AND farm_id = ${farmId}::uuid AND fingerprint = ${expectedFingerprint} FOR UPDATE`
          if (!enrollments[0]) return { ok: false, reason: 'denied' }
          const credentials = await readRevocationCredentialRecords(tx, agentId)
          const tombstones = await tx<
            Tombstone[]
          >`SELECT farm_id, fingerprint, credential_jti, revoked_at::float8 FROM farm.connector_revocations WHERE agent_id = ${agentId}::uuid`
          const now = this.now()
          if (now < initialNow) return { ok: false, reason: 'denied' }
          const current = evaluateSession(
            sessionRecordId,
            sessions[0] ?? null,
            accounts[0] ?? null,
            now,
            policy,
          )
          if (!current.ok) {
            if (current.reason === 'expired')
              await tx`UPDATE farm.account_sessions SET revoked_at = ${now} WHERE id = ${sessionRecordId}`
            return { ok: false, reason: 'denied' }
          }
          const credential = credentials[0]
          const previous = tombstones[0]
          if (
            !enrollments[0] ||
            (credential &&
              (credential.farm_id !== farmId ||
                credential.fingerprint !== expectedFingerprint)) ||
            (previous &&
              (previous.farm_id !== farmId ||
                previous.fingerprint !== expectedFingerprint ||
                previous.credential_jti !== (credential?.jti ?? null)))
          )
            return { ok: false, reason: 'denied' }
          if (previous && enrollments[0].status !== 'revoked')
            return { ok: false, reason: 'denied' }
          let touchAt = current.touchAt
          if (!previous) {
            try {
              touchAt = await tx.savepoint(async (save) => {
                await save`UPDATE farm.connector_enrollments SET status = 'revoked' WHERE agent_id = ${agentId}::uuid`
                await save`INSERT INTO farm.connector_revocations (agent_id, farm_id, fingerprint, credential_jti, revoked_at, revoked_by) VALUES (${agentId}::uuid, ${farmId}::uuid, ${expectedFingerprint}, ${credential?.jti ?? null}::uuid, ${now}, ${current.accountId})`
                const writtenAt = this.now()
                const writtenSession = evaluateSession(
                  sessionRecordId,
                  sessions[0] ?? null,
                  accounts[0] ?? null,
                  writtenAt,
                  policy,
                )
                if (writtenAt < now || !writtenSession.ok)
                  throw new RevocationAuthorizationExpired(
                    writtenAt,
                    !writtenSession.ok && writtenSession.reason === 'expired',
                  )
                return writtenSession.touchAt
              })
            } catch (error) {
              if (!(error instanceof RevocationAuthorizationExpired))
                throw error
              if (error.sessionExpired)
                await tx`UPDATE farm.account_sessions SET revoked_at = ${error.observedAt} WHERE id = ${sessionRecordId}`
              return { ok: false, reason: 'denied' }
            }
          }
          await tx`UPDATE farm.account_sessions SET last_seen_at = ${touchAt} WHERE id = ${sessionRecordId}`
          return {
            ok: true,
            status: 'revoked',
            credential: credential ? 'revoked' : 'not-issued',
            revokedAt: previous?.revoked_at ?? now,
          }
        },
      )
    } catch {
      return { ok: false, reason: 'storage-unavailable' }
    }
  }
}
