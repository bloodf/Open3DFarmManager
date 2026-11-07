import { randomBytes, randomUUID } from 'node:crypto'
import type { Sql, TransactionSql } from 'postgres'
import {
  BrowserDeviceTextId as sessionId,
  BrowserDeviceIssueRequest as issueRequest,
  BrowserDeviceCompletionRequest as completionRequest,
  BrowserDeviceDecisionRequest as decisionRequest,
  BrowserDeviceRecord as Device,
  type BrowserDeviceRecord,
  BrowserDeviceSnapshotRequest,
  BrowserDeviceRole,
  BrowserDeviceProofChallenge,
  BROWSER_DEVICE_PROOF_TTL_MS,
  validateBrowserDevicePublicKey,
  verifyBrowserDeviceProof,
} from '../../../../packages/farm-protocol/src/browser-device-proof.ts'
import {
  PairingProofOrigin,
  PairingProofAudience,
} from '../../../../packages/farm-protocol/src/pairing-proof.ts'
import {
  BrowserDeviceHttpListRequest,
  BrowserDeviceHttpListResponse,
  BROWSER_DEVICE_HTTP_LIMITS,
} from '../../../../packages/farm-protocol/src/browser-device-http.ts'
import {
  evaluateSession,
  type SessionPolicy,
  type SessionRecord,
  type AccountSessionState,
} from '../utils/auth/session-contract.ts'

type BrowserDevice = BrowserDeviceRecord
export type { BrowserDeviceRecord as BrowserDevice } from '../../../../packages/farm-protocol/src/browser-device-proof.ts'
export type BrowserDeviceRegistryFailure = {
  ok: false
  reason: 'invalid-input' | 'denied' | 'capacity' | 'storage-unavailable'
}
type Result<T> = ({ ok: true } & T) | BrowserDeviceRegistryFailure
type Input = {
  sessionRecordId: string
  policy: SessionPolicy
  request: unknown
}
type Auth = {
  account: AccountSessionState
  record: SessionRecord
  role: string
}
const denied = (): BrowserDeviceRegistryFailure => ({
  ok: false,
  reason: 'denied',
})
const PENDING_LIFETIME_MS = 24 * 60 * 60 * 1000
const deviceColumns =
  'key_id, farm_id, account_id, public_key, thumbprint, status, proof_at::float8 AS proof_at'

/** Internal capability. Only reviewed sealed-cookie server code may supply sessionRecordId.
 * It is a database reference, never a bearer credential or an authentication API.
 */
export class PostgresBrowserDeviceRegistry {
  private readonly origin: string
  private readonly audience: string
  private readonly sql: Sql
  private readonly clock: () => number
  constructor(
    sql: Sql,
    config: { origin: string; audience: string },
    clock: () => number = Date.now,
  ) {
    this.sql = sql
    this.clock = clock
    this.origin = PairingProofOrigin.parse(config.origin)
    this.audience = PairingProofAudience.parse(config.audience)
  }
  private now(): number {
    const now = this.clock()
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      now > Number.MAX_SAFE_INTEGER - BROWSER_DEVICE_PROOF_TTL_MS
    )
      throw new Error('Invalid registry clock')
    return now
  }
  private valid(input: Input): boolean {
    return (
      sessionId.safeParse(input.sessionRecordId).success &&
      Number.isSafeInteger(input.policy?.idleTimeoutMs) &&
      input.policy.idleTimeoutMs > 0
    )
  }
  private async transaction<T>(
    run: (tx: TransactionSql) => Promise<Result<T>>,
  ): Promise<Result<T>> {
    try {
      return await this.sql.begin(async (tx) => {
        await tx`SET LOCAL statement_timeout = '2000ms'`
        await tx`SET LOCAL lock_timeout = '1000ms'`
        // ponytail: one bounded internal registry lock; split capacities per scope before exposing high-volume routes.
        await tx`SELECT pg_advisory_xact_lock(1870033, 13)`
        return run(tx)
      })
    } catch {
      return { ok: false, reason: 'storage-unavailable' }
    }
  }
  private async authorize(
    tx: TransactionSql,
    id: string,
    farm: string,
    policy: SessionPolicy,
  ): Promise<Auth | null> {
    const accounts = await tx<
      AccountSessionState[]
    >`SELECT id, session_version::float8 AS "sessionVersion", disabled FROM farm.session_accounts WHERE id = (SELECT account_id FROM farm.account_sessions WHERE id=${id}) FOR UPDATE`
    const records = await tx<
      SessionRecord[]
    >`SELECT id,account_id AS "accountId",account_version::float8 AS "accountVersion",created_at::float8 AS "createdAt",last_seen_at::float8 AS "lastSeenAt",absolute_expires_at::float8 AS "absoluteExpiresAt",revoked_at::float8 AS "revokedAt" FROM farm.account_sessions WHERE id=${id} FOR UPDATE`
    const account = accounts[0],
      record = records[0]
    if (
      !account ||
      !record ||
      !evaluateSession(id, record, account, this.now(), policy).ok
    )
      return null
    const members =
      await tx`SELECT role,revoked_at FROM farm.memberships WHERE farm_id=${farm}::uuid AND account_id=${account.id} FOR SHARE`
    const member = members[0]
    if (
      !member ||
      member.revoked_at !== null ||
      !['owner', 'admin', 'operator', 'viewer'].includes(member.role)
    )
      return null
    return { account, record, role: member.role }
  }
  private async finish(
    tx: TransactionSql,
    input: Input,
    auth: Auth,
    notBefore: number,
  ): Promise<void> {
    const now = this.now()
    if (
      now < notBefore ||
      !evaluateSession(
        input.sessionRecordId,
        auth.record,
        auth.account,
        now,
        input.policy,
      ).ok
    )
      throw new Error('Authorization expired during registry transaction')
    await tx`UPDATE farm.account_sessions SET last_seen_at=${now} WHERE id=${input.sessionRecordId}`
  }
  /** Bounded metadata only; callers must not interpret a listing as a command lease. */
  async list(input: Input): Promise<Result<BrowserDeviceHttpListResponse>> {
    const parsed = BrowserDeviceHttpListRequest.safeParse(input.request)
    if (!parsed.success || !this.valid(input))
      return { ok: false, reason: 'invalid-input' }
    return this.transaction(async (tx) => {
      const request = parsed.data
      const auth = await this.authorize(
        tx,
        input.sessionRecordId,
        request.farm_id,
        input.policy,
      )
      if (!auth) return denied()
      const now = this.now()
      const all = auth.role === 'owner' || auth.role === 'admin'
      const rows =
        await tx`SELECT key_id AS "keyId",account_id AS "accountId",thumbprint,status,proof_at::float8 AS "proofAt",created_at::float8 AS "createdAt",CASE WHEN status='pending' THEN (created_at+86400000)::float8 ELSE NULL END AS "pendingExpiresAt" FROM farm.browser_device_keys WHERE farm_id=${request.farm_id}::uuid AND (${all} OR account_id=${auth.account.id}) AND (${request.after ?? null}::uuid IS NULL OR key_id>${request.after ?? null}::uuid) ORDER BY key_id LIMIT ${request.limit + 1}`
      const devices = rows.slice(0, request.limit)
      const last = devices.at(-1)
      const response = BrowserDeviceHttpListResponse.parse({
        currentAccountId: auth.account.id,
        currentRole: auth.role,
        devices,
        nextAfter: rows.length > request.limit && last ? last.keyId : null,
        limits: BROWSER_DEVICE_HTTP_LIMITS,
      })
      await this.finish(tx, input, auth, now)
      return { ok: true, ...response }
    })
  }
  async issueChallenge(
    input: Input,
  ): Promise<Result<{ challenge: BrowserDeviceProofChallenge }>> {
    const parsed = issueRequest.safeParse(input.request)
    if (!parsed.success || !this.valid(input))
      return { ok: false, reason: 'invalid-input' }
    let binding: Awaited<ReturnType<typeof validateBrowserDevicePublicKey>>
    try {
      binding = await validateBrowserDevicePublicKey(parsed.data.public_key)
    } catch {
      return { ok: false, reason: 'invalid-input' }
    }
    const request = parsed.data
    return this.transaction(async (tx) => {
      const auth = await this.authorize(
        tx,
        input.sessionRecordId,
        request.farm_id,
        input.policy,
      )
      if (!auth) return denied()
      const now = this.now()
      const existing =
        await tx`SELECT ${tx.unsafe(deviceColumns)}, created_at::float8 AS created_at FROM farm.browser_device_keys WHERE farm_id=${request.farm_id}::uuid AND account_id=${auth.account.id} AND thumbprint=${binding.thumbprint} FOR UPDATE`
      const row = existing[0]
      if (
        row &&
        (row.status === 'revoked' ||
          (row.status === 'pending' &&
            now - row.created_at >= PENDING_LIFETIME_MS) ||
          now < row.created_at ||
          (request.purpose === 'enroll'
            ? row.proof_at !== null
            : row.proof_at === null))
      )
        return denied()
      if (!row && request.purpose === 'recover') return denied()
      const counts =
        await tx`SELECT (SELECT count(*)::int FROM farm.browser_device_keys) AS keys, (SELECT count(*)::int FROM farm.browser_device_challenges) AS challenges`
      const scoped =
        await tx`SELECT count(*)::int AS account_keys,count(*) FILTER (WHERE farm_id=${request.farm_id}::uuid)::int AS farm_keys FROM farm.browser_device_keys WHERE account_id=${auth.account.id}`
      if (
        (!row &&
          (counts[0]?.keys >= 10000 ||
            scoped[0]?.account_keys >= 128 ||
            scoped[0]?.farm_keys >= 32)) ||
        counts[0]?.challenges >= 30000
      )
        return { ok: false, reason: 'capacity' }
      const keyId = row?.key_id ?? randomUUID()
      const attempts =
        await tx`SELECT count(*)::int AS n, count(*) FILTER (WHERE consumed_at IS NULL AND expires_at>${now})::int AS active FROM farm.browser_device_challenges WHERE key_id=${keyId}::uuid`
      if (attempts[0]?.n >= 3 || attempts[0]?.active > 0)
        return { ok: false, reason: 'capacity' }
      if (!row)
        await tx`INSERT INTO farm.browser_device_keys(key_id,farm_id,account_id,public_key,thumbprint,created_at) VALUES(${keyId}::uuid,${request.farm_id}::uuid,${auth.account.id},${tx.json(binding.publicKey)},${binding.thumbprint},${now})`
      const challenge = BrowserDeviceProofChallenge.parse({
        v: 1,
        purpose: request.purpose,
        challenge_id: randomUUID(),
        farm_id: request.farm_id,
        key_id: keyId,
        account_id: auth.account.id,
        session_id: randomUUID(),
        thumbprint: binding.thumbprint,
        origin: this.origin,
        audience: this.audience,
        nonce: randomBytes(32).toString('base64url'),
        issued_at: now,
        expires_at: now + BROWSER_DEVICE_PROOF_TTL_MS,
      })
      await tx`INSERT INTO farm.browser_device_challenges(challenge_id,key_id,session_id,challenge,issued_at,expires_at) VALUES(${challenge.challenge_id}::uuid,${keyId}::uuid,${input.sessionRecordId},${tx.json(challenge)},${now},${challenge.expires_at})`
      await this.finish(tx, input, auth, now)
      return { ok: true, challenge }
    })
  }
  async completeProof(
    input: Input,
  ): Promise<Result<{ device: BrowserDevice }>> {
    const parsed = completionRequest.safeParse(input.request)
    if (!parsed.success || !this.valid(input))
      return { ok: false, reason: 'invalid-input' }
    return this.transaction(async (tx) => {
      // Read immutable scope before account/session locks; re-read challenge under lock below.
      const scopes =
        await tx`SELECT challenge FROM farm.browser_device_challenges WHERE challenge_id=${parsed.data.challenge_id}::uuid`
      if (!scopes[0]) return denied()
      const challenge = BrowserDeviceProofChallenge.parse(scopes[0].challenge)
      const auth = await this.authorize(
        tx,
        input.sessionRecordId,
        challenge.farm_id,
        input.policy,
      )
      if (
        !auth ||
        challenge.account_id !== auth.account.id ||
        challenge.origin !== this.origin ||
        challenge.audience !== this.audience
      )
        return denied()
      const keys =
        await tx`SELECT ${tx.unsafe(deviceColumns)},created_at::float8 AS created_at FROM farm.browser_device_keys WHERE key_id=${challenge.key_id}::uuid FOR UPDATE`
      const rows =
        await tx`SELECT consumed_at,session_id FROM farm.browser_device_challenges WHERE challenge_id=${challenge.challenge_id}::uuid FOR UPDATE`
      const keyRow = keys[0]
      if (!keyRow) return denied()
      const device = Device.parse(keyRow)
      if (
        !rows[0] ||
        rows[0].session_id !== input.sessionRecordId ||
        rows[0].consumed_at !== null
      )
        return denied()
      const now = this.now()
      if (now < challenge.issued_at) return denied()
      let valid =
        device.status !== 'revoked' &&
        (device.status !== 'pending' ||
          now - keyRow.created_at < PENDING_LIFETIME_MS) &&
        device.account_id === auth.account.id &&
        device.farm_id === challenge.farm_id &&
        (await verifyBrowserDeviceProof(
          challenge,
          device.public_key,
          parsed.data.signature,
        ))
      const verifiedAt = this.now()
      valid = valid && verifiedAt >= now && verifiedAt < challenge.expires_at
      await tx`UPDATE farm.browser_device_challenges SET consumed_at=${Math.max(now, verifiedAt)}, outcome=${verifiedAt >= challenge.expires_at ? 'expired' : valid ? 'verified' : 'rejected'} WHERE challenge_id=${challenge.challenge_id}::uuid`
      if (!valid) return denied()
      await tx`UPDATE farm.browser_device_keys SET proof_at=${verifiedAt},proof_session_id=${input.sessionRecordId} WHERE key_id=${device.key_id}::uuid`
      await this.finish(tx, input, auth, verifiedAt)
      const commitAt = this.now()
      if (
        commitAt >= challenge.expires_at ||
        (device.status === 'pending' &&
          commitAt - keyRow.created_at >= PENDING_LIFETIME_MS)
      )
        throw new Error('Proof expired before commit')
      return { ok: true, device: { ...device, proof_at: verifiedAt } }
    })
  }
  /** Server-only snapshot for a future authenticated lease issuer. No bearer or command authorization. */
  async authorizeDevice(input: Input): Promise<
    Result<{
      device: BrowserDevice
      role: 'owner' | 'admin' | 'operator' | 'viewer'
      proofSessionId: string
      validUntil: number
    }>
  > {
    const parsed = BrowserDeviceSnapshotRequest.safeParse(input.request)
    if (!parsed.success || !this.valid(input))
      return { ok: false, reason: 'invalid-input' }
    return this.transaction(async (tx) => {
      const request = parsed.data
      const auth = await this.authorize(
        tx,
        input.sessionRecordId,
        request.farm_id,
        input.policy,
      )
      if (!auth) return denied()
      const rows =
        await tx`SELECT ${tx.unsafe(deviceColumns)} FROM farm.browser_device_keys WHERE key_id=${request.key_id}::uuid AND farm_id=${request.farm_id}::uuid AND account_id=${auth.account.id} FOR SHARE`
      if (!rows[0]) return denied()
      const device = Device.parse(rows[0])
      if (device.status !== 'approved') return denied()
      const proofs =
        await tx`SELECT issued_at::float8 AS issued_at,expires_at::float8 AS expires_at,consumed_at::float8 AS consumed_at FROM farm.browser_device_challenges WHERE key_id=${device.key_id}::uuid AND session_id=${input.sessionRecordId} AND outcome='verified' AND challenge->>'session_id'=${request.proof_session_id} AND challenge->>'origin'=${this.origin} AND challenge->>'audience'=${this.audience} FOR SHARE`
      const proof = proofs[0]
      const now = this.now()
      if (!proof || now < proof.consumed_at || now >= proof.expires_at)
        return denied()
      const role = BrowserDeviceRole.parse(auth.role)
      const validUntil = Math.min(
        proof.expires_at,
        auth.record.absoluteExpiresAt,
        now + BROWSER_DEVICE_PROOF_TTL_MS,
        now + input.policy.idleTimeoutMs,
      )
      await this.finish(tx, input, auth, now)
      if (this.now() >= validUntil)
        throw new Error('Snapshot expired before commit')
      return {
        ok: true,
        device,
        role,
        proofSessionId: request.proof_session_id,
        validUntil,
      }
    })
  }
  async approve(input: Input): Promise<Result<{ device: BrowserDevice }>> {
    return this.decide(input, 'approved')
  }
  async revoke(input: Input): Promise<Result<{ device: BrowserDevice }>> {
    return this.decide(input, 'revoked')
  }
  private async decide(
    input: Input,
    status: 'approved' | 'revoked',
  ): Promise<Result<{ device: BrowserDevice }>> {
    const parsed = decisionRequest.safeParse(input.request)
    if (!parsed.success || !this.valid(input))
      return { ok: false, reason: 'invalid-input' }
    const request = parsed.data
    return this.transaction(async (tx) => {
      // Lock both immutable identity scopes before authorizing either actor.
      const scopes =
        await tx`SELECT account_id,proof_session_id FROM farm.browser_device_keys WHERE key_id=${request.key_id}::uuid AND farm_id=${request.farm_id}::uuid`
      const actors =
        await tx`SELECT account_id FROM farm.account_sessions WHERE id=${input.sessionRecordId}`
      if (!scopes[0] || !actors[0]) return denied()
      const accounts = [
        ...new Set([actors[0].account_id, scopes[0].account_id]),
      ].sort()
      const sessions = [
        ...new Set(
          [input.sessionRecordId, scopes[0].proof_session_id].filter(
            (id): id is string => typeof id === 'string',
          ),
        ),
      ].sort()
      await tx`SELECT id FROM farm.session_accounts WHERE id IN ${tx(accounts)} ORDER BY id FOR UPDATE`
      await tx`SELECT id FROM farm.account_sessions WHERE id IN ${tx(sessions)} ORDER BY id FOR UPDATE`
      await tx`SELECT account_id FROM farm.memberships WHERE farm_id=${request.farm_id}::uuid AND account_id IN ${tx(accounts)} ORDER BY account_id FOR SHARE`

      const auth = await this.authorize(
        tx,
        input.sessionRecordId,
        request.farm_id,
        input.policy,
      )
      if (!auth || !['owner', 'admin'].includes(auth.role)) return denied()
      const keys =
        await tx`SELECT ${tx.unsafe(deviceColumns)},proof_session_id,created_at::float8 AS created_at FROM farm.browser_device_keys WHERE key_id=${request.key_id}::uuid AND farm_id=${request.farm_id}::uuid FOR UPDATE`
      if (!keys[0]) return denied()
      const device = Device.parse(keys[0])
      const now = this.now()
      if (device.thumbprint !== request.expected_thumbprint) return denied()
      let targetAuth: Auth | null = null
      if (status === 'approved') {
        if (
          device.status === 'revoked' ||
          device.proof_at === null ||
          (device.status === 'pending' &&
            now - keys[0].created_at >= PENDING_LIFETIME_MS) ||
          now < device.proof_at
        )
          return denied()
        const target = await this.authorize(
          tx,
          keys[0].proof_session_id,
          request.farm_id,
          input.policy,
        )
        if (!target || target.account.id !== device.account_id) return denied()
        targetAuth = target
        const approvalNow = this.now()
        if (
          approvalNow < now ||
          !evaluateSession(
            target.record.id,
            target.record,
            target.account,
            approvalNow,
            input.policy,
          ).ok
        )
          return denied()
        if (device.status === 'pending')
          await tx`UPDATE farm.browser_device_keys SET status='approved',approved_at=${now},approved_by=${auth.account.id} WHERE key_id=${device.key_id}::uuid`
      } else if (device.status !== 'revoked')
        await tx`UPDATE farm.browser_device_keys SET status='revoked',revoked_at=${now},revoked_by=${auth.account.id} WHERE key_id=${device.key_id}::uuid`
      await this.finish(tx, input, auth, now)
      const commitAt = this.now()
      if (
        status === 'approved' &&
        (!targetAuth ||
          commitAt < now ||
          !evaluateSession(
            targetAuth.record.id,
            targetAuth.record,
            targetAuth.account,
            commitAt,
            input.policy,
          ).ok ||
          (device.status === 'pending' &&
            commitAt - keys[0].created_at >= PENDING_LIFETIME_MS))
      )
        throw new Error('Approval expired before commit')
      return { ok: true, device: { ...device, status } }
    })
  }
}
