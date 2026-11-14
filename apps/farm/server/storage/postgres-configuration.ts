import {
  ConfigurationAuthority,
  ConfigurationScope,
  ConfigurationOperationRecord,
  ConfigurationChallengeRecord,
  ConfigurationReceiptRecord,
  ConfigurationReceiptRegistration,
  type ConfigurationAuthorityTransaction,
} from '../services/configuration-authority-contract.ts'
import { readPauseNegotiationCredentialRecords } from './postgres-connector-credential-record.ts'
import { z } from 'zod'
import postgres, { type Sql, type TransactionSql } from 'postgres'
import {
  BrowserDeviceTextId,
  BrowserDeviceUuid,
  validateBrowserDevicePublicKey,
} from '../../../../packages/farm-protocol/src/browser-device-proof.ts'
import { PairingPublicKey } from '../../../../packages/farm-protocol/src/pairing.ts'
import {
  PairingProofOrigin,
  PairingProofAudience,
} from '../../../../packages/farm-protocol/src/pairing-proof.ts'
import { deriveConfigurationAssignmentIdentity } from '../../../../packages/farm-protocol/src/configuration-inventory.ts'
import { connectorKeyBinding } from '../utils/connector-credentials.ts'
import { evaluateSession } from '../utils/auth/session-contract.ts'

const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const digest = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/)
const role = z.enum(['owner', 'admin'])
const Config = z.strictObject({
  origin: PairingProofOrigin,
  audience: PairingProofAudience,
  credentialIssuer: z.string().min(1).max(256),
  credentialAudience: z.string().min(1).max(256),
  idleTimeoutMs: z.literal(1_800_000),
})
export type PauseNegotiationConfig = z.infer<typeof Config>
type PauseNegotiationScope = ConfigurationScope
type PauseNegotiationAuthority = ConfigurationAuthority
const fields = ConfigurationAuthority.shape
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
type Candidate = {
  account: z.infer<typeof Account>
  session: z.infer<typeof Session>
  authority: PauseNegotiationAuthority
  credentialIssuedAt: number
  slotObservedAt: number | null
}

/** Single write boundary for jsonb record columns: the driver serializes the parsed
 * record once as a structured jsonb parameter (oid 3802). Passing a pre-stringified value
 * would persist a jsonb string scalar that strict record parsing correctly rejects. */
function jsonbRecord(
  tx: TransactionSql,
  record: Parameters<TransactionSql['json']>[0],
) {
  return tx.json(record)
}

/** Total attempts, including the first, for one logical configuration transaction. */
const MAX_SERIALIZABLE_ATTEMPTS = 3

/** True only for a driver-reported SQLSTATE 40001. PostgreSQL has already rolled that
 * transaction back (statement or COMMIT failure), so nothing from the attempt is durable.
 * Connection loss, lock/statement timeouts, deadlocks, TRANSACTION_ROLLED_BACK and
 * callback errors are not proof of a rollback-only outcome and are never retried. */
function rolledBackSerializationFailure(error: unknown) {
  return error instanceof postgres.PostgresError && error.code === '40001'
}

/** Reads authority and persists admission/registration in one serializable transaction.
 * The supplied pool must
 * run under reviewed farm_configuration_authority: a mutation-capable role, not read-only SQL.
 * The expiry observer may persist terminal session expiry, but no session is touched.
 * sessionRecordId comes from the sealed-login owner, not a browser request field.
 * A concurrent session touch can make the expiry observer fail with SQLSTATE 40001; the
 * whole attempt is then rerun, at most MAX_SERIALIZABLE_ATTEMPTS times, each in a fresh
 * serializable transaction that re-reads session, account, membership, browser key,
 * enrollment and credential authority and the observed time. Nothing is carried over.
 * Callback restriction: `work` may run more than once and only the committed attempt's
 * result is returned, so its effects must stay inside `tx` or be pure (validation,
 * hashing, signing, random IDs, in-process registry reads). It must not perform upstream
 * calls, physical or other side effects, and must not swallow database errors. */
export class PostgresConfigurationStore {
  private readonly sql: Sql
  private readonly config: PauseNegotiationConfig
  constructor(sql: Sql, config: unknown) {
    this.sql = sql
    this.config = Object.freeze(Config.parse(config))
  }
  async read(scope: ConfigurationScope) {
    return this.transaction(scope, async (tx) =>
      tx.authority
        ? { authority: tx.authority, observedAt: tx.observedAt }
        : null,
    )
  }
  async transaction<T>(
    input: ConfigurationScope,
    work: (tx: ConfigurationAuthorityTransaction) => Promise<T>,
  ): Promise<T> {
    const scope = ConfigurationScope.parse(input)
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.attempt(scope, work)
      } catch (error) {
        if (
          attempt >= MAX_SERIALIZABLE_ATTEMPTS ||
          !rolledBackSerializationFailure(error)
        )
          throw error
      }
    }
  }
  private async attempt<T>(
    scope: ConfigurationScope,
    work: (tx: ConfigurationAuthorityTransaction) => Promise<T>,
  ): Promise<T> {
    let result!: T
    await this.sql.begin('isolation level serializable', async (tx) => {
      const first = await this.observe(tx, scope.sessionRecordId)
      const candidate =
        first === null ? null : await this.current(tx, scope, first)
      const now = await this.observe(tx, scope.sessionRecordId)
      const authority =
        candidate &&
        now !== null &&
        first !== null &&
        now >= first &&
        now >= candidate.credentialIssuedAt &&
        now < candidate.authority.validUntil &&
        (candidate.slotObservedAt === null ||
          now >= candidate.slotObservedAt) &&
        evaluateSession(
          scope.sessionRecordId,
          candidate.session,
          candidate.account,
          now,
          this.config,
        ).ok
          ? candidate.authority
          : null
      const transaction: ConfigurationAuthorityTransaction = {
        authority,
        observedAt: now ?? 0,
        operation: async (id) => {
          const rows =
            await tx`SELECT record FROM farm.configuration_operations WHERE operation_id=${id}::uuid FOR UPDATE`
          return rows.length
            ? ConfigurationOperationRecord.parse(rows[0]?.record)
            : null
        },
        createOperation: async (input) => {
          const r = ConfigurationOperationRecord.parse(input)
          const rows =
            await tx`INSERT INTO farm.configuration_operations(operation_id,record) VALUES (${r.operation_id}::uuid,${jsonbRecord(tx, r)}) ON CONFLICT DO NOTHING RETURNING operation_id`
          return rows.length === 1
        },
        pinCommit: async (id, hash) => {
          const rows =
            await tx`UPDATE farm.configuration_operations SET record=jsonb_set(record,'{commit_sha256}',to_jsonb(${hash}::text)) WHERE operation_id=${id}::uuid AND record->>'commit_sha256' IS NULL RETURNING operation_id`
          return rows.length === 1
        },
        insertChallenge: async (input) => {
          const r = ConfigurationChallengeRecord.parse(input)
          const rows =
            await tx`INSERT INTO farm.configuration_challenges(challenge_id,capability_id,admission_nonce,record) VALUES (${r.challenge.challenge_id}::uuid,${r.challenge.capability_id}::uuid,${r.challenge.admission_nonce},${jsonbRecord(tx, r)}) ON CONFLICT DO NOTHING RETURNING challenge_id`
          return rows.length === 1
        },
        consumeChallenge: async (id) => {
          const rows =
            await tx`UPDATE farm.configuration_challenges SET consumed=true WHERE challenge_id=${id}::uuid AND NOT consumed RETURNING record`
          return rows.length
            ? ConfigurationChallengeRecord.parse(rows[0]?.record)
            : null
        },
        receipt: async (id) => {
          const rows =
            await tx`SELECT operation_id::text,receipt_sha256,assignment_id::text FROM farm.configuration_receipts WHERE operation_id=${id}::uuid`
          return rows.length ? ConfigurationReceiptRecord.parse(rows[0]) : null
        },
        registerReceipt: async (input) => {
          const r = ConfigurationReceiptRegistration.parse(input)
          const canonical = await deriveConfigurationAssignmentIdentity({
            account_id: r.account_id,
            farm_id: r.farm_id,
            agent_id: r.agent_id,
            bridge_instance_id: r.bridge_instance_id,
            device_id: r.device_id,
          })
          if (
            !authority ||
            r.account_id !== authority.account_id ||
            r.farm_id !== authority.farm_id ||
            r.agent_id !== authority.agent_id ||
            r.assignment_id !== canonical.assignment_id ||
            r.printer_key !== canonical.printer_key
          )
            return { ok: false }
          const op = await transaction.operation(r.operation_id)
          if (
            !op ||
            op.account_id !== r.account_id ||
            op.farm_id !== r.farm_id ||
            op.agent_id !== r.agent_id ||
            op.key_id !== scope.keyId ||
            r.committed_revision !== op.expected_revision + 1 ||
            !op.commit_sha256
          )
            return { ok: false }
          const prior =
            await tx`SELECT record,assignment_id::text FROM farm.configuration_receipts WHERE operation_id=${r.operation_id}::uuid`
          if (prior.length) {
            const previous = ConfigurationReceiptRegistration.parse(
              prior[0]?.record,
            )
            return previous.receipt_wire === r.receipt_wire &&
              previous.receipt_sha256 === r.receipt_sha256 &&
              previous.bridge_instance_id === r.bridge_instance_id &&
              previous.device_id === r.device_id &&
              previous.assignment_id === canonical.assignment_id &&
              previous.printer_key === canonical.printer_key &&
              previous.committed_revision === r.committed_revision &&
              String(prior[0]?.assignment_id) === canonical.assignment_id
              ? { ok: true, assignmentId: canonical.assignment_id }
              : { ok: false }
          }
          const assigned =
            await tx`INSERT INTO farm.printer_assignments(id,farm_id,agent_id,printer_key,created_at,created_by) VALUES (${canonical.assignment_id}::uuid,${r.farm_id}::uuid,${r.agent_id}::uuid,${canonical.printer_key},${r.registered_at},${r.account_id}) ON CONFLICT DO NOTHING RETURNING id`
          if (!assigned.length) return { ok: false }
          await tx`INSERT INTO farm.configuration_receipts(operation_id,receipt_sha256,assignment_id,record) VALUES (${r.operation_id}::uuid,${r.receipt_sha256},${canonical.assignment_id}::uuid,${jsonbRecord(tx, r)})`
          return { ok: true, assignmentId: canonical.assignment_id }
        },
      }
      result = await work(transaction)
    })
    return result
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
      await tx`SELECT id,session_version::float8 AS "sessionVersion",disabled FROM farm.session_accounts WHERE id=(SELECT account_id FROM farm.account_sessions WHERE id=${scope.sessionRecordId}) FOR SHARE`
    const sessions =
      await tx`SELECT id,account_id AS "accountId",account_version::float8 AS "accountVersion",created_at::float8 AS "createdAt",last_seen_at::float8 AS "lastSeenAt",absolute_expires_at::float8 AS "absoluteExpiresAt",revoked_at::float8 AS "revokedAt" FROM farm.account_sessions WHERE id=${scope.sessionRecordId} FOR SHARE`
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
    const authority = ConfigurationAuthority.parse({
      farm_id: scope.farmId,
      agent_id: scope.agentId,
      account_id: account.data.id,
      key_id: scope.keyId,
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
      credentialIssuedAt,
      slotObservedAt: slot?.observed_at ?? null,
    }
  }
}
