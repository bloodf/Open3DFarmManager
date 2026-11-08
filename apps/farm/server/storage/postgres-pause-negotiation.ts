import { readPauseNegotiationCredentialRecords } from './postgres-connector-credential-record.ts'
import { z } from 'zod'
import type { Sql, TransactionSql } from 'postgres'
import {
  BrowserDeviceTextId,
  BrowserDeviceUuid,
  validateBrowserDevicePublicKey,
} from '../../../../packages/farm-protocol/src/browser-device-proof.ts'
import { ControlSessionBinding } from '../../../../packages/farm-protocol/src/control-session-binding.ts'
import { PauseCapabilityV1 } from '../../../../packages/farm-protocol/src/pause-capability.ts'
import { PairingPublicKey } from '../../../../packages/farm-protocol/src/pairing.ts'
import {
  PairingProofOrigin,
  PairingProofAudience,
} from '../../../../packages/farm-protocol/src/pairing-proof.ts'
import { connectorKeyBinding } from '../utils/connector-credentials.ts'
import { evaluateSession } from '../utils/auth/session-contract.ts'
import {
  signallingClockSample,
  signallingReadBudget,
  type SignallingReadBudget,
} from '../services/signalling-clock.ts'

const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const digest = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/)
const role = z.enum(['owner', 'admin', 'operator'])
const Config = z.strictObject({
  origin: PairingProofOrigin,
  audience: PairingProofAudience,
  credentialIssuer: z.string().min(1).max(256),
  credentialAudience: z.string().min(1).max(256),
  idleTimeoutMs: z.literal(1_800_000),
})
export type PauseNegotiationConfig = z.infer<typeof Config>
export const PauseNegotiationScope = z.strictObject({
  sessionRecordId: BrowserDeviceTextId,
  farmId: BrowserDeviceUuid,
  agentId: BrowserDeviceUuid,
  keyId: BrowserDeviceUuid,
  assignmentId: BrowserDeviceUuid,
})
export type PauseNegotiationScope = z.infer<typeof PauseNegotiationScope>
const fields = ControlSessionBinding.shape
export const PauseNegotiationAuthority = z.strictObject({
  farm_id: fields.farm_id,
  agent_id: fields.agent_id,
  account_id: fields.account_id,
  key_id: fields.key_id,
  assignment_id: fields.assignment_id,
  browser_public_key: fields.browser_public_key,
  browser_thumbprint: fields.browser_thumbprint,
  connector_public_key_spki: fields.connector_public_key_spki,
  connector_fingerprint: fields.connector_fingerprint,
  credential_jti: fields.credential_jti,
  origin: fields.origin,
  audience: fields.audience,
  role,
  validUntil: time,
})
export type PauseNegotiationAuthority = Readonly<
  z.infer<typeof PauseNegotiationAuthority>
>
export type PauseNegotiationSnapshot = Readonly<{
  authority: PauseNegotiationAuthority
  /** Local server metadata only; not a URL or client-selected command destination. */
  printerKey: string
  budget: SignallingReadBudget
}>
const Account = z.strictObject({
  id: BrowserDeviceTextId,
  sessionVersion: time,
  disabled: z.boolean(),
})
const Session = z.strictObject({
  id: BrowserDeviceTextId,
  accountId: BrowserDeviceTextId,
  accountVersion: time,
  createdAt: time,
  lastSeenAt: time,
  absoluteExpiresAt: time,
  revokedAt: time.nullable(),
})
const Member = z.strictObject({ role, revoked_at: z.null() })
const Key = z.strictObject({
  status: z.literal('approved'),
  public_key: fields.browser_public_key,
  thumbprint: digest,
  approved_at: z
    .unknown()
    .refine((value) => value !== null && value !== undefined),
  revoked_at: z.null(),
})
const Enrollment = z.strictObject({
  farm_id: BrowserDeviceUuid,
  status: z.literal('approved'),
  public_key_spki: PairingPublicKey,
  fingerprint: fields.connector_fingerprint,
})
const Credential = z.strictObject({
  jti: BrowserDeviceUuid,
  farm_id: BrowserDeviceUuid,
  fingerprint: fields.connector_fingerprint,
  thumbprint: digest,
  issuer: z.string(),
  audience: z.string(),
  issued_at: time,
  expires_at: time,
})
const Slot = z.strictObject({
  observed_at: time,
  credential_expired_at: time.nullable(),
})
const Assignment = z.strictObject({
  farm_id: BrowserDeviceUuid,
  agent_id: BrowserDeviceUuid,
  printer_key: PauseCapabilityV1.shape.printer_key,
  revoked_at: z.null(),
})
type Candidate = {
  account: z.infer<typeof Account>
  session: z.infer<typeof Session>
  authority: PauseNegotiationAuthority
  printerKey: string
  credentialIssuedAt: number
  slotObservedAt: number | null
}

/** Reads fresh negotiation metadata, never a command grant. The supplied pool must
 * run under reviewed farm_pause_authority: a mutation-capable role, not read-only SQL.
 * The expiry observer may persist terminal session expiry, but no session is touched.
 * sessionRecordId comes from the sealed-login owner, not a browser request field. */
export class PostgresPauseNegotiation {
  private readonly sql: Sql
  private readonly config: PauseNegotiationConfig
  constructor(sql: Sql, config: unknown) {
    this.sql = sql
    this.config = Object.freeze(Config.parse(config))
  }
  async read(input: unknown): Promise<PauseNegotiationSnapshot | null> {
    const parsed = PauseNegotiationScope.safeParse(input)
    if (!parsed.success) return null
    const scope = Object.freeze(parsed.data)
    try {
      const clock = { wall: Date.now, monotonic: () => performance.now() }
      const start = signallingClockSample(clock)
      const result = await this.sql.begin(async (tx) => {
        await tx`SET LOCAL statement_timeout='2000ms'`
        await tx`SET LOCAL lock_timeout='1000ms'`
        await tx`SET LOCAL transaction_timeout='10000ms'`
        const first = await this.observe(tx, scope.sessionRecordId)
        if (first === null) return null
        const candidate = await this.current(tx, scope, first)
        // Even a denied row may have waited. Commit newly observed terminal expiry.
        const observedAt = await this.observe(tx, scope.sessionRecordId)
        if (
          !candidate ||
          observedAt === null ||
          observedAt < first ||
          observedAt < candidate.credentialIssuedAt ||
          observedAt >= candidate.authority.validUntil ||
          (candidate.slotObservedAt !== null &&
            observedAt < candidate.slotObservedAt) ||
          !evaluateSession(
            scope.sessionRecordId,
            candidate.session,
            candidate.account,
            observedAt,
            this.config,
          ).ok
        )
          return null
        return {
          authority: candidate.authority,
          printerKey: candidate.printerKey,
          observedAt,
        }
      })
      const end = signallingClockSample(clock)
      if (!result) return null
      const budget = Object.freeze(
        signallingReadBudget({
          start,
          end,
          observedAt: result.observedAt,
          validUntil: result.authority.validUntil,
        }),
      )
      return Object.freeze({
        authority: result.authority,
        printerKey: result.printerKey,
        budget,
      })
    } catch {
      return null
    }
  }
  private async observe(
    tx: TransactionSql,
    sessionId: string,
  ): Promise<number | null> {
    const rows =
      await tx`SELECT farm.observe_signalling_session_expiry(${sessionId})::float8 AS now`
    return time.nullable().parse(rows[0]?.now)
  }
  private async current(
    tx: TransactionSql,
    scope: PauseNegotiationScope,
    observedAt: number,
  ): Promise<Candidate | null> {
    const accounts =
      await tx`SELECT id,session_version::float8 AS "sessionVersion",disabled FROM farm.session_accounts WHERE id=(SELECT account_id FROM farm.account_sessions WHERE id=${scope.sessionRecordId})`
    const sessions =
      await tx`SELECT id,account_id AS "accountId",account_version::float8 AS "accountVersion",created_at::float8 AS "createdAt",last_seen_at::float8 AS "lastSeenAt",absolute_expires_at::float8 AS "absoluteExpiresAt",revoked_at::float8 AS "revokedAt" FROM farm.account_sessions WHERE id=${scope.sessionRecordId}`
    const account = Account.safeParse(accounts[0]),
      session = Session.safeParse(sessions[0])
    if (
      !account.success ||
      !session.success ||
      !evaluateSession(
        scope.sessionRecordId,
        session.data,
        account.data,
        observedAt,
        this.config,
      ).ok
    )
      return null
    const members =
      await tx`SELECT role,revoked_at FROM farm.memberships WHERE farm_id=${scope.farmId}::uuid AND account_id=${account.data.id} FOR SHARE`
    const member = Member.safeParse(members[0])
    if (!member.success) return null
    const keys =
      await tx`SELECT status,public_key,thumbprint,approved_at,revoked_at FROM farm.browser_device_keys WHERE key_id=${scope.keyId}::uuid AND farm_id=${scope.farmId}::uuid AND account_id=${account.data.id} FOR SHARE`
    const key = Key.safeParse(keys[0])
    if (!key.success) return null
    const enrollments =
      await tx`SELECT farm_id,status,public_key_spki,fingerprint FROM farm.connector_enrollments WHERE agent_id=${scope.agentId}::uuid FOR SHARE`
    const enrollment = Enrollment.safeParse(enrollments[0])
    if (!enrollment.success || enrollment.data.farm_id !== scope.farmId)
      return null
    // Unique agent_id in 0010. Parent UPDATE also serializes an initially absent 0014 slot.
    const credentials = await readPauseNegotiationCredentialRecords(
      tx,
      scope.agentId,
    )
    const credential = Credential.safeParse(credentials[0])
    if (
      !credential.success ||
      credentials.length !== 1 ||
      credential.data.farm_id !== scope.farmId ||
      credential.data.fingerprint !== enrollment.data.fingerprint ||
      credential.data.issuer !== this.config.credentialIssuer ||
      credential.data.audience !== this.config.credentialAudience
    )
      return null
    const slots =
      await tx`SELECT observed_at::float8 AS observed_at,credential_expired_at::float8 AS credential_expired_at FROM farm.connector_credential_proofs WHERE jti=${credential.data.jti}::uuid FOR SHARE`
    const slot = slots.length ? Slot.parse(slots[0]) : null
    if (slots.length > 1 || slot?.credential_expired_at != null) return null
    const revoked =
      await tx`SELECT agent_id FROM farm.connector_revocations WHERE agent_id=${scope.agentId}::uuid OR credential_jti=${credential.data.jti}::uuid`
    if (revoked.length) return null
    const assignments =
      await tx`SELECT farm_id,agent_id,printer_key,revoked_at FROM farm.printer_assignments WHERE id=${scope.assignmentId}::uuid FOR SHARE`
    const assignment = Assignment.safeParse(assignments[0])
    if (
      !assignment.success ||
      assignment.data.farm_id !== scope.farmId ||
      assignment.data.agent_id !== scope.agentId
    )
      return null
    // Native public-material validation happens under all locks, before the final DB observation.
    const browser = await validateBrowserDevicePublicKey(key.data.public_key)
    const connector = await connectorKeyBinding(enrollment.data.public_key_spki)
    if (
      browser.thumbprint !== key.data.thumbprint ||
      connector.fingerprint !== enrollment.data.fingerprint ||
      connector.thumbprint !== credential.data.thumbprint
    )
      return null
    const credentialIssuedAt = time.parse(credential.data.issued_at * 1000)
    const expiresAt = time.parse(credential.data.expires_at * 1000)
    if (expiresAt <= credentialIssuedAt) return null
    const validUntil = time.parse(
      Math.min(
        session.data.absoluteExpiresAt,
        time.parse(session.data.lastSeenAt + this.config.idleTimeoutMs),
        expiresAt,
      ),
    )
    const authority = PauseNegotiationAuthority.parse({
      farm_id: scope.farmId,
      agent_id: scope.agentId,
      account_id: account.data.id,
      key_id: scope.keyId,
      assignment_id: scope.assignmentId,
      browser_public_key: browser.publicKey,
      browser_thumbprint: browser.thumbprint,
      connector_public_key_spki: enrollment.data.public_key_spki,
      connector_fingerprint: connector.fingerprint,
      credential_jti: credential.data.jti,
      origin: this.config.origin,
      audience: this.config.audience,
      role: member.data.role,
      validUntil,
    })
    Object.freeze(authority.browser_public_key)
    Object.freeze(authority)
    return {
      account: account.data,
      session: session.data,
      authority,
      printerKey: assignment.data.printer_key,
      credentialIssuedAt,
      slotObservedAt: slot?.observed_at ?? null,
    }
  }
}
