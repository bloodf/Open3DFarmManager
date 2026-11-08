import { readSignallingCredentialRecords } from './postgres-connector-credential-record.ts'
import {
  assignmentSetDigest,
  RtcAssignmentRef,
} from '../../../../packages/farm-protocol/src/rtc-assignment-set.ts'
import { z } from 'zod'
import type { Sql, TransactionSql } from 'postgres'
import {
  BrowserDeviceTextId,
  BrowserDeviceUuid,
  validateBrowserDevicePublicKey,
} from '../../../../packages/farm-protocol/src/browser-device-proof.ts'
import {
  PairingProofOrigin,
  PairingProofAudience,
} from '../../../../packages/farm-protocol/src/pairing-proof.ts'
import { connectorKeyBinding } from '../utils/connector-credentials.ts'
import {
  evaluateSession,
  type AccountSessionState,
  type SessionRecord,
} from '../utils/auth/session-contract.ts'
import {
  signallingClockSample,
  signallingReadBudget,
  type SignallingClock,
  type SignallingReadBudget,
} from '../services/signalling-clock.ts'
import type {
  SignallingAuthoritySnapshot,
  SignallingAuthority,
  SignallingAuthoritySource,
  SignallingScope,
} from '../services/signalling-coordinator.ts'
/** Coupled deliberately to migration 0017 and the maintained auth runtime policy. */
export const SIGNALLING_IDLE_TIMEOUT_MS = 1_800_000
const Config = z.strictObject({
  issuer: z.string().min(1).max(256),
  origin: PairingProofOrigin,
  audience: PairingProofAudience,
  idleTimeoutMs: z.literal(SIGNALLING_IDLE_TIMEOUT_MS),
})
export type SignallingReaderConfig = z.infer<typeof Config>
const Scope = z.strictObject({
  sessionRecordId: BrowserDeviceTextId,
  farmId: BrowserDeviceUuid,
  agentId: BrowserDeviceUuid,
  keyId: BrowserDeviceUuid,
})
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const Credential = z.strictObject({
  jti: BrowserDeviceUuid,
  farm_id: BrowserDeviceUuid,
  fingerprint: z.string(),
  thumbprint: z.string(),
  issuer: z.string(),
  audience: z.string(),
  issued_at: time,
  expires_at: time,
})
const Assignment = z.strictObject({
  id: BrowserDeviceUuid,
  farm_id: BrowserDeviceUuid,
  agent_id: BrowserDeviceUuid,
  printer_key: RtcAssignmentRef.shape.printerKey,
  revoked_at: z.null(),
})
const ConnectorScope = z.strictObject({
  agentId: BrowserDeviceUuid,
  farmId: BrowserDeviceUuid,
  jti: BrowserDeviceUuid,
})
export type ConnectorCurrentIdentity = Pick<
  SignallingAuthority,
  | 'agent_id'
  | 'farm_id'
  | 'connector_public_key_spki'
  | 'connector_fingerprint'
  | 'credential_jti'
  | 'origin'
  | 'audience'
  | 'validUntil'
>
export interface ConnectorCurrentSnapshot {
  identity: ConnectorCurrentIdentity
  budget: SignallingReadBudget
}
export type SignallingReadDecision =
  | { ok: true; authority: SignallingAuthority; observedAt: number }
  | { ok: false; reason: 'denied' | 'invalid-input' | 'storage-unavailable' }
/** No bearer/session-cookie parsing or network authority is supplied by this adapter.
 * The expiry-only function owns session locks and uses DB time; callers supply neither clock nor policy.
 * Denial is a normal committed transaction so observed session expiry remains terminal. */
export class PostgresSignallingAuthorization implements SignallingAuthoritySource {
  private sql: Sql
  private config: SignallingReaderConfig
  private readonly clock: SignallingClock
  constructor(
    sql: Sql,
    config: unknown,
    clock: SignallingClock = {
      wall: Date.now,
      monotonic: () => performance.now(),
    },
  ) {
    this.sql = sql
    this.config = Config.parse(config)
    this.clock = clock
  }
  async read(
    scope: SignallingScope,
  ): Promise<SignallingAuthoritySnapshot | null> {
    try {
      const start = signallingClockSample(this.clock)
      const result = await this.authorize(scope)
      const end = signallingClockSample(this.clock)
      if (!result.ok) return null
      return {
        authority: result.authority,
        budget: signallingReadBudget({
          start,
          end,
          observedAt: result.observedAt,
          validUntil: result.authority.validUntil,
        }),
      }
    } catch {
      return null
    }
  }
  async readConnectorCurrent(
    input: unknown,
  ): Promise<ConnectorCurrentSnapshot | null> {
    const parsed = ConnectorScope.safeParse(input)
    if (!parsed.success) return null
    try {
      const start = signallingClockSample(this.clock)
      const candidate = await this.sql.begin(async (tx) => {
        await tx`SET LOCAL statement_timeout = '2000ms'`
        await tx`SET LOCAL lock_timeout = '1000ms'`
        const first = await this.databaseTime(tx)
        const identity = await this.connector(
          tx,
          parsed.data.agentId,
          parsed.data.farmId,
          first,
        )
        const observedAt = await this.databaseTime(tx)
        if (
          !identity ||
          observedAt < first ||
          observedAt >= identity.validUntil ||
          identity.credential_jti !== parsed.data.jti
        )
          return null
        return { identity, observedAt }
      })
      const end = signallingClockSample(this.clock)
      if (!candidate) return null
      return {
        identity: candidate.identity,
        budget: signallingReadBudget({
          start,
          end,
          observedAt: candidate.observedAt,
          validUntil: candidate.identity.validUntil,
        }),
      }
    } catch {
      return null
    }
  }
  private async databaseTime(tx: TransactionSql): Promise<number> {
    const rows =
      await tx`SELECT floor(extract(epoch FROM pg_catalog.clock_timestamp()) * 1000)::float8 AS observed_at`
    return time.parse(rows[0]?.observed_at)
  }
  async authorize(input: unknown): Promise<SignallingReadDecision> {
    const parsed = Scope.safeParse(input)
    if (!parsed.success) return { ok: false, reason: 'invalid-input' }
    const scope = parsed.data
    try {
      return await this.sql.begin(async (tx) => {
        await tx`SET LOCAL statement_timeout = '2000ms'`
        await tx`SET LOCAL lock_timeout = '1000ms'`
        const first = await this.observe(tx, scope.sessionRecordId)
        if (first === null)
          return {
            ok: false,
            reason: 'denied',
          } satisfies SignallingReadDecision
        // observe locks account SHARE before session UPDATE and checks immutable account binding.
        const accounts = await tx<
          AccountSessionState[]
        >`SELECT id, session_version::float8 AS "sessionVersion", disabled FROM farm.session_accounts WHERE id = (SELECT account_id FROM farm.account_sessions WHERE id = ${scope.sessionRecordId})`
        const sessions = await tx<
          SessionRecord[]
        >`SELECT id, account_id AS "accountId", account_version::float8 AS "accountVersion", created_at::float8 AS "createdAt", last_seen_at::float8 AS "lastSeenAt", absolute_expires_at::float8 AS "absoluteExpiresAt", revoked_at::float8 AS "revokedAt" FROM farm.account_sessions WHERE id = ${scope.sessionRecordId}`
        const session = sessions[0] ?? null,
          account = accounts[0] ?? null
        const initial = evaluateSession(
          scope.sessionRecordId,
          session,
          account,
          first,
          this.config,
        )
        const candidate = initial.ok
          ? await this.snapshot(tx, scope, initial.accountId, first)
          : null
        // Even a denied snapshot may have waited for a row. Expiry observed after that wait commits.
        const final = await this.observe(tx, scope.sessionRecordId)
        if (final === null)
          return {
            ok: false,
            reason: 'denied',
          } satisfies SignallingReadDecision
        const current = evaluateSession(
          scope.sessionRecordId,
          session,
          account,
          Math.max(first, final),
          this.config,
        )
        if (!candidate || !current.ok || final < first || !session)
          return {
            ok: false,
            reason: 'denied',
          } satisfies SignallingReadDecision
        const validUntil = Math.min(
          session.absoluteExpiresAt,
          session.lastSeenAt + this.config.idleTimeoutMs,
          candidate.credentialExpiresAt,
        )
        if (!Number.isSafeInteger(validUntil) || final >= validUntil)
          return {
            ok: false,
            reason: 'denied',
          } satisfies SignallingReadDecision
        const { credentialExpiresAt: _, ...authority } = candidate
        return {
          ok: true,
          authority: { ...authority, validUntil },
          observedAt: final,
        } satisfies SignallingReadDecision
      })
    } catch {
      return { ok: false, reason: 'storage-unavailable' }
    }
  }
  private async observe(
    tx: TransactionSql,
    sessionId: string,
  ): Promise<number | null> {
    const rows =
      await tx`SELECT farm.observe_signalling_session_expiry(${sessionId})::float8 AS observed_at`
    return time.nullable().parse(rows[0]?.observed_at)
  }
  private async snapshot(
    tx: TransactionSql,
    scope: SignallingScope,
    accountId: string,
    observedAt: number,
  ): Promise<
    | (Omit<SignallingAuthority, 'validUntil'> & {
        credentialExpiresAt: number
      })
    | null
  > {
    const members =
      await tx`SELECT role, revoked_at FROM farm.memberships WHERE farm_id = ${scope.farmId}::uuid AND account_id = ${accountId} FOR SHARE`
    if (
      !members[0] ||
      members[0].revoked_at !== null ||
      !['owner', 'admin', 'operator', 'viewer'].includes(members[0].role)
    )
      return null
    const keys =
      await tx`SELECT public_key, thumbprint, status, revoked_at, approved_at FROM farm.browser_device_keys WHERE key_id = ${scope.keyId}::uuid AND farm_id = ${scope.farmId}::uuid AND account_id = ${accountId} FOR SHARE`
    const key = keys[0]
    if (
      !key ||
      key.status !== 'approved' ||
      key.revoked_at !== null ||
      key.approved_at === null
    )
      return null
    const [browser, connector] = await Promise.all([
      validateBrowserDevicePublicKey(key.public_key),
      this.connector(tx, scope.agentId, scope.farmId, observedAt),
    ])
    if (!connector || browser.thumbprint !== key.thumbprint) return null
    // connector() holds enrollment SHARE through digesting and final session/time
    // checks. Maintained register/revoke take enrollment UPDATE before any write,
    // including an insert into an initially empty set. Do not filter by caller refs.
    const rows =
      await tx`SELECT id, farm_id, agent_id, printer_key, revoked_at FROM farm.printer_assignments WHERE farm_id = ${scope.farmId}::uuid AND agent_id = ${scope.agentId}::uuid AND revoked_at IS NULL ORDER BY id LIMIT 17`
    if (!rows.length || rows.length > 16) return null
    const assignments = z.array(Assignment).safeParse([...rows])
    if (
      !assignments.success ||
      assignments.data.some(
        (row) => row.farm_id !== scope.farmId || row.agent_id !== scope.agentId,
      )
    )
      return null
    const assignmentSet = await assignmentSetDigest(
      { farmId: scope.farmId, agentId: scope.agentId },
      assignments.data.map((row) => ({
        assignmentId: row.id,
        agentId: row.agent_id,
        printerKey: row.printer_key,
      })),
    )
    return {
      assignment_count: assignmentSet.count,
      assignment_digest: assignmentSet.digest,
      farm_id: scope.farmId,
      agent_id: scope.agentId,
      account_id: accountId,
      key_id: scope.keyId,
      browser_public_key: browser.publicKey,
      browser_thumbprint: browser.thumbprint,
      connector_public_key_spki: connector.connector_public_key_spki,
      connector_fingerprint: connector.connector_fingerprint,
      credential_jti: connector.credential_jti,
      origin: this.config.origin,
      audience: this.config.audience,
      credentialExpiresAt: connector.validUntil,
    }
  }
  private async connector(
    tx: TransactionSql,
    agentId: string,
    farmId: string,
    observedAt: number,
  ): Promise<ConnectorCurrentIdentity | null> {
    // Same enrollment -> credential order as revocation and proof acceptance.
    const enrollments =
      await tx`SELECT farm_id, public_key_spki, fingerprint, status FROM farm.connector_enrollments WHERE agent_id = ${agentId}::uuid FOR SHARE`
    const enrollment = enrollments[0]
    if (
      !enrollment ||
      enrollment.farm_id !== farmId ||
      enrollment.status !== 'approved'
    )
      return null
    const issued =
      await readSignallingCredentialRecords(tx, agentId)
    const parsed = Credential.safeParse(issued[0])
    if (!parsed.success) return null
    const credential = parsed.data
    if (
      credential.farm_id !== farmId ||
      credential.fingerprint !== enrollment.fingerprint ||
      credential.issuer !== this.config.issuer ||
      credential.audience !== this.config.audience ||
      credential.issued_at * 1000 > observedAt ||
      credential.expires_at * 1000 <= observedAt
    )
      return null
    const revoked =
      await tx`SELECT agent_id FROM farm.connector_revocations WHERE agent_id = ${agentId}::uuid OR credential_jti = ${credential.jti}::uuid`
    if (revoked.length) return null
    const connector = await connectorKeyBinding(enrollment.public_key_spki)
    if (
      connector.fingerprint !== enrollment.fingerprint ||
      connector.thumbprint !== credential.thumbprint
    )
      return null
    return {
      agent_id: agentId,
      farm_id: farmId,
      connector_public_key_spki: enrollment.public_key_spki,
      connector_fingerprint: connector.fingerprint,
      credential_jti: credential.jti,
      origin: this.config.origin,
      audience: this.config.audience,
      validUntil: credential.expires_at * 1000,
    }
  }
}
