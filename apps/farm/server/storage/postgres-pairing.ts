import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'
import {
  PAIRING_TTL_MS,
  PairingStartRequest,
  PairingStartResponse,
  PairingApprovalRequest,
  PairingPollRequest,
} from '@open3dfarmmanager/farm-protocol'
import {
  evaluateSession,
  type SessionPolicy,
  type SessionRecord,
  type AccountSessionState,
} from '../utils/auth/session-contract.ts'

const alphabet = 'BCDFGHJKLMNPQRSTVWXZ23456789'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
type Failure = {
  ok: false
  reason: 'invalid-input' | 'denied' | 'storage-unavailable' | 'capacity'
}
type Decision = { ok: true; status: 'approved' | 'denied' } | Failure
/** Internal handoff only. This is neither a bearer token nor a protocol poll response. */
export type PairingClaim =
  | { ok: true; status: 'pending' | 'slow_down'; retry_after_s: 5 }
  | { ok: true; status: 'expired' | 'denied' }
  | {
      ok: true
      status: 'claimed'
      agentId: string
      farmId: string
      publicKeySpki: string
      fingerprint: string
    }
  | Failure
interface PairingRow {
  agent_id: string
  public_key_spki: string
  fingerprint: string
  issued_at: number
  expires_at: number
  next_poll_at: number
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'consumed'
  farm_id: string | null
}

/** Unwired internal persistence. Clock is sampled after lock acquisition, not before waiting. */
export class PostgresPairing {
  constructor(
    private readonly sql: Sql,
    private readonly clock: () => number = Date.now,
  ) {}
  private now(): number {
    const now = this.clock()
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      now > Number.MAX_SAFE_INTEGER - PAIRING_TTL_MS
    )
      throw new Error('Invalid pairing clock')
    return now
  }
  async start(
    input: unknown,
  ): Promise<{ ok: true; response: PairingStartResponse } | Failure> {
    const parsed = PairingStartRequest.safeParse(input)
    if (!parsed.success) return { ok: false, reason: 'invalid-input' }
    const request = parsed.data
    const deviceCode = randomBytes(32).toString('base64url')
    const userCode = Array.from({ length: 8 }, () =>
      alphabet.charAt(randomInt(alphabet.length)),
    ).join('')
    const fingerprint =
      'SHA256:' +
      createHash('sha256')
        .update(Buffer.from(request.public_key_spki, 'base64url'))
        .digest('base64url')
    try {
      return await this.sql.begin(async (tx) => {
        await tx`SET LOCAL statement_timeout = '2000ms'`
        await tx`SET LOCAL lock_timeout = '1000ms'`
        // Bound active requests across all application instances.
        await tx`SELECT pg_advisory_xact_lock(1870033, 7)`
        const now = this.now()
        const count =
          await tx`SELECT count(*)::int AS n FROM farm.pairing_requests WHERE status IN ('pending', 'approved') AND expires_at > ${now}`
        if (count[0]?.n >= 1000)
          return { ok: false, reason: 'capacity' } satisfies Failure
        const response = PairingStartResponse.parse({
          device_code: deviceCode,
          user_code: userCode,
          fingerprint,
          issued_at: now,
          expires_at: now + PAIRING_TTL_MS,
          poll_interval_s: 5,
        })
        await tx`INSERT INTO farm.pairing_requests (agent_id, device_code_hash, user_code_hash, public_key_spki, fingerprint, platform, version, issued_at, expires_at, next_poll_at) VALUES (${randomUUID()}::uuid, ${hash(deviceCode)}, ${hash(userCode)}, ${request.public_key_spki}, ${fingerprint}, ${request.platform}, ${request.version}, ${now}, ${response.expires_at}, ${now})`
        return { ok: true, response } as const
      })
    } catch {
      return { ok: false, reason: 'storage-unavailable' }
    }
  }
  async decide(input: {
    request: unknown
    sessionRecordId: string
    policy: SessionPolicy
    decision: 'approve' | 'deny'
  }): Promise<Decision> {
    const parsed = PairingApprovalRequest.safeParse(input.request)
    if (
      !parsed.success ||
      !['approve', 'deny'].includes(input.decision) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.sessionRecordId)
    )
      return { ok: false, reason: 'invalid-input' }
    const request = parsed.data
    try {
      return await this.sql.begin(async (tx): Promise<Decision> => {
        await tx`SET LOCAL statement_timeout = '2000ms'`
        await tx`SET LOCAL lock_timeout = '1000ms'`
        // Same account -> session -> membership lock order as enrollment authorization.
        const accounts = await tx<
          AccountSessionState[]
        >`SELECT id, session_version::float8 AS "sessionVersion", disabled FROM farm.session_accounts WHERE id = (SELECT account_id FROM farm.account_sessions WHERE id = ${input.sessionRecordId}) FOR UPDATE`
        const sessions = await tx<
          SessionRecord[]
        >`SELECT id, account_id AS "accountId", account_version::float8 AS "accountVersion", created_at::float8 AS "createdAt", last_seen_at::float8 AS "lastSeenAt", absolute_expires_at::float8 AS "absoluteExpiresAt", revoked_at::float8 AS "revokedAt" FROM farm.account_sessions WHERE id = ${input.sessionRecordId} FOR UPDATE`
        const account = accounts[0] ?? null
        const record = sessions[0] ?? null
        const initialNow = this.now()
        const initial = evaluateSession(
          input.sessionRecordId,
          record,
          account,
          initialNow,
          input.policy,
        )
        if (!initial.ok) {
          if (initial.reason === 'expired')
            await tx`UPDATE farm.account_sessions SET revoked_at = ${initialNow} WHERE id = ${input.sessionRecordId}`
          return { ok: false, reason: 'denied' }
        }
        const members =
          await tx`SELECT role, revoked_at FROM farm.memberships WHERE farm_id = ${request.farm_id}::uuid AND account_id = ${initial.accountId} FOR SHARE`
        if (
          !members[0] ||
          members[0].revoked_at !== null ||
          !['owner', 'admin'].includes(members[0].role)
        )
          return { ok: false, reason: 'denied' }
        const rows = await tx<
          PairingRow[]
        >`SELECT agent_id, public_key_spki, fingerprint, issued_at::float8, expires_at::float8, next_poll_at::float8, status, farm_id FROM farm.pairing_requests WHERE user_code_hash = ${hash(request.user_code)} FOR UPDATE`
        const now = this.now()
        if (now < initialNow) return { ok: false, reason: 'denied' }
        const session = evaluateSession(
          input.sessionRecordId,
          record,
          account,
          now,
          input.policy,
        )
        if (!session.ok) {
          if (session.reason === 'expired')
            await tx`UPDATE farm.account_sessions SET revoked_at = ${now} WHERE id = ${input.sessionRecordId}`
          return { ok: false, reason: 'denied' }
        }
        const row = rows[0]
        if (
          !row ||
          row.status !== 'pending' ||
          row.fingerprint !== request.expected_fingerprint ||
          now < row.issued_at
        )
          return { ok: false, reason: 'denied' }
        if (now >= row.expires_at) {
          await tx`UPDATE farm.pairing_requests SET status = 'expired' WHERE agent_id = ${row.agent_id}::uuid`
          return { ok: false, reason: 'denied' }
        }
        if (input.decision === 'deny') {
          await tx`UPDATE farm.pairing_requests SET status = 'denied' WHERE agent_id = ${row.agent_id}::uuid`
        } else {
          await tx`INSERT INTO farm.connector_enrollments (agent_id, farm_id, public_key_spki, fingerprint) VALUES (${row.agent_id}::uuid, ${request.farm_id}::uuid, ${row.public_key_spki}, ${row.fingerprint})`
          await tx`UPDATE farm.connector_enrollments SET status = 'approved' WHERE agent_id = ${row.agent_id}::uuid`
          await tx`UPDATE farm.pairing_requests SET status = 'approved', farm_id = ${request.farm_id}::uuid, decided_by = ${session.accountId} WHERE agent_id = ${row.agent_id}::uuid`
        }
        await tx`UPDATE farm.account_sessions SET last_seen_at = ${session.touchAt} WHERE id = ${input.sessionRecordId}`
        return {
          ok: true,
          status: input.decision === 'approve' ? 'approved' : 'denied',
        }
      })
    } catch {
      return { ok: false, reason: 'storage-unavailable' }
    }
  }
  /** Consumes an approved code once. Future token issuance must join this transaction before exposing an endpoint. */
  async claim(input: unknown): Promise<PairingClaim> {
    const parsed = PairingPollRequest.safeParse(input)
    if (!parsed.success) return { ok: false, reason: 'invalid-input' }
    try {
      return await this.sql.begin(async (tx): Promise<PairingClaim> => {
        await tx`SET LOCAL statement_timeout = '2000ms'`
        await tx`SET LOCAL lock_timeout = '1000ms'`
        const rows = await tx<
          PairingRow[]
        >`SELECT agent_id, public_key_spki, fingerprint, issued_at::float8, expires_at::float8, next_poll_at::float8, status, farm_id FROM farm.pairing_requests WHERE device_code_hash = ${hash(parsed.data.device_code)} FOR UPDATE`
        const row = rows[0]
        const now = this.now()
        if (!row || now < row.issued_at || row.status === 'consumed')
          return { ok: false, reason: 'denied' }
        if (row.status === 'denied' || row.status === 'expired')
          return { ok: true, status: row.status }
        if (now >= row.expires_at) {
          // Approved remains an immutable authorization decision; expiry prevents delivery.
          if (row.status === 'pending')
            await tx`UPDATE farm.pairing_requests SET status = 'expired' WHERE agent_id = ${row.agent_id}::uuid`
          return { ok: true, status: 'expired' }
        }
        if (now < row.next_poll_at)
          return { ok: true, status: 'slow_down', retry_after_s: 5 }
        if (row.status === 'pending') {
          await tx`UPDATE farm.pairing_requests SET next_poll_at = ${Math.min(now + 5000, row.expires_at)} WHERE agent_id = ${row.agent_id}::uuid`
          return { ok: true, status: 'pending', retry_after_s: 5 }
        }
        const enrolled =
          await tx`SELECT status, farm_id FROM farm.connector_enrollments WHERE agent_id = ${row.agent_id}::uuid FOR SHARE`
        if (
          !row.farm_id ||
          enrolled[0]?.status !== 'approved' ||
          enrolled[0]?.farm_id !== row.farm_id
        )
          return { ok: false, reason: 'denied' }
        const deliveryNow = this.now()
        if (deliveryNow < now || deliveryNow >= row.expires_at)
          return { ok: true, status: 'expired' }
        await tx`UPDATE farm.pairing_requests SET status = 'consumed' WHERE agent_id = ${row.agent_id}::uuid`
        return {
          ok: true,
          status: 'claimed',
          agentId: row.agent_id,
          farmId: row.farm_id,
          publicKeySpki: row.public_key_spki,
          fingerprint: row.fingerprint,
        }
      })
    } catch {
      return { ok: false, reason: 'storage-unavailable' }
    }
  }
}
