import { readPauseAuthorityCredentialRecords } from './postgres-connector-credential-record.ts'
import { randomUUID } from 'node:crypto'
import type { Sql, TransactionSql } from 'postgres'
import { z } from 'zod'
import { canonicalize } from '../../../../packages/farm-protocol/src/canonical.ts'
import {
  base64url,
  decodeBase64url,
} from '../../../../packages/farm-protocol/src/encoding.ts'
import {
  BrowserDeviceTextId,
  BrowserDevicePublicKey,
} from '../../../../packages/farm-protocol/src/browser-device-proof.ts'
import {
  PairingProofOrigin,
  PairingProofAudience,
} from '../../../../packages/farm-protocol/src/pairing-proof.ts'
import {
  ControlSessionBinding,
  decodeControlProof,
  controlBindingHash,
  verifyControlSessionProof,
} from '../../../../packages/farm-protocol/src/control-session-binding.ts'
import {
  PausePolicy,
  PAUSE_POLICY_HARD_MAXIMUMS,
  PauseAdmissionChallenge,
  decodePauseAdmissionProof,
  verifyPauseAdmissionProof,
  PauseCapabilityV1,
  signPauseCapability,
  encodePauseCapability,
  type SignedPauseCapabilityV1,
} from '../../../../packages/farm-protocol/src/pause-capability.ts'
import {
  evaluateSession,
  type AccountSessionState,
  type SessionRecord,
} from '../utils/auth/session-contract.ts'

const MAX_TIME = Number.MAX_SAFE_INTEGER - 3_600_000
const time = z.number().int().nonnegative().max(MAX_TIME)
const digest = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/)
const ChallengeInput = z.strictObject({
  sessionRecordId: BrowserDeviceTextId,
  request: z.strictObject({
    browserProofWire: z.string().max(8192),
    connectorProofWire: z.string().max(8192),
    admissionNonce: digest,
  }),
})
const CapabilityInput = z.strictObject({
  sessionRecordId: BrowserDeviceTextId,
  request: z.strictObject({ admissionProofWire: z.string().max(8192) }),
})
const Config = z.strictObject({
  origin: PairingProofOrigin,
  audience: PairingProofAudience,
  issuer: PairingProofAudience,
  kid: PauseCapabilityV1.shape.kid,
  credentialIssuer: z.string().min(1).max(256),
  credentialAudience: z.string().min(1).max(256),
  idleTimeoutMs: z.literal(1_800_000),
})
export interface PauseAuthorityIssuerConfig extends z.infer<typeof Config> {
  signingKey: CryptoKey
  verificationKey: CryptoKey
  policy?: Partial<PausePolicy>
}
export type PauseAuthorityFailure = {
  ok: false
  reason:
    | 'invalid-input'
    | 'denied'
    | 'capacity'
    | 'rate-limited'
    | 'storage-unavailable'
}
export type PauseChallengeDecision =
  { ok: true; challenge: PauseAdmissionChallenge } | PauseAuthorityFailure
export type PauseCapabilityDecision =
  { ok: true; capability: SignedPauseCapabilityV1 } | PauseAuthorityFailure
const denied = (): PauseAuthorityFailure => ({ ok: false, reason: 'denied' })
type Current = {
  account: AccountSessionState
  session: SessionRecord
  role: 'owner' | 'admin' | 'operator'
  credentialExpiresAt: number
  validUntil: number
  printerKey: string
}
type ChallengeRow = {
  challenge_id: string
  session_id: string
  account_id: string
  binding: unknown
  challenge: unknown
  status: string
  issued_at: number
  expires_at: number
}
class ExpiredIssuance extends Error {}

/** Internal authority only. The caller must derive sessionRecordId from its reviewed sealed-cookie flow.
 * Configuration, clocks, roles and private login references never come from request bodies. */
export class PostgresPauseAuthority {
  private readonly config: z.infer<typeof Config>
  private readonly policy: PausePolicy
  private readonly signingKey: CryptoKey
  private readonly verificationKey: CryptoKey
  private ready: Promise<boolean> | undefined
  private readonly sql: Sql
  constructor(sql: Sql, config: PauseAuthorityIssuerConfig) {
    this.sql = sql
    const { signingKey, verificationKey, policy, ...metadata } = config
    this.config = Object.freeze(Config.parse(metadata))
    this.policy = Object.freeze(
      PausePolicy.parse({
        ...PAUSE_POLICY_HARD_MAXIMUMS,
        ...PausePolicy.partial().parse(policy ?? {}),
      }),
    )
    if (
      !(signingKey instanceof CryptoKey) ||
      signingKey.type !== 'private' ||
      signingKey.extractable ||
      signingKey.algorithm.name !== 'Ed25519' ||
      signingKey.usages.length !== 1 ||
      signingKey.usages[0] !== 'sign' ||
      !(verificationKey instanceof CryptoKey) ||
      verificationKey.type !== 'public' ||
      verificationKey.algorithm.name !== 'Ed25519' ||
      verificationKey.usages.length !== 1 ||
      verificationKey.usages[0] !== 'verify'
    )
      throw new Error('Invalid trusted pause issuer keys')
    this.signingKey = signingKey
    this.verificationKey = verificationKey
  }
  private validConfiguration(): Promise<boolean> {
    // Lazy and caught: constructing an unused service never starts an orphan rejecting promise.
    this.ready ??= (async () => {
      const payload = new TextEncoder().encode(
        'Open3DFarmManager/pause-issuer-key-check/v1\0',
      )
      const signature = await crypto.subtle.sign(
        'Ed25519',
        this.signingKey,
        payload,
      )
      return crypto.subtle.verify(
        'Ed25519',
        this.verificationKey,
        signature,
        payload,
      )
    })().catch(() => false)
    return this.ready
  }
  private async transaction<
    T extends PauseChallengeDecision | PauseCapabilityDecision,
  >(
    run: (
      tx: TransactionSql,
      setDeliveryDeadline: (deadline: number) => void,
    ) => Promise<T>,
  ): Promise<T | PauseAuthorityFailure> {
    try {
      let result: T | undefined
      let deliveryDeadline: number | undefined
      await this.sql.begin(async (tx) => {
        await tx`SET LOCAL statement_timeout='2000ms'`
        await tx`SET LOCAL lock_timeout='1000ms'`
        await tx`SET LOCAL transaction_timeout='10000ms'`
        result = await run(tx, (deadline) => {
          deliveryDeadline = time.parse(deadline)
        })
      })
      if (result?.ok) {
        const authority =
          'challenge' in result ? result.challenge : result.capability
        // Deduct the entire bounded freshness transaction, including its COMMIT wait.
        const started = performance.now()
        let observedNow: number | undefined
        let observedWatermark: number | undefined
        await this.sql.begin(async (check) => {
          await check`SET LOCAL statement_timeout='2000ms'`
          await check`SET LOCAL lock_timeout='1000ms'`
          await check`SET LOCAL transaction_timeout='10000ms'`
          const rows =
            await check`SELECT floor(extract(epoch FROM pg_catalog.clock_timestamp())*1000)::float8 AS now,observed_at::float8 AS watermark FROM farm.pause_authority_watermark WHERE id=1`
          observedNow = time.parse(rows[0]?.now)
          observedWatermark = time.parse(rows[0]?.watermark)
        })
        const elapsed = Math.ceil(performance.now() - started)
        const fresh =
          deliveryDeadline !== undefined &&
          Number.isSafeInteger(elapsed) &&
          elapsed >= 0 &&
          elapsed < 2000 &&
          observedNow !== undefined &&
          observedWatermark !== undefined &&
          observedNow >= observedWatermark &&
          observedNow >= authority.issued_at &&
          observedNow + elapsed <
            Math.min(deliveryDeadline, authority.expires_at)
        if (!fresh) return denied()
      }
      return result ?? { ok: false, reason: 'storage-unavailable' }
    } catch {
      return { ok: false, reason: 'storage-unavailable' }
    }
  }
  private async now(tx: TransactionSql): Promise<number> {
    const rows =
      await tx`SELECT floor(extract(epoch FROM pg_catalog.clock_timestamp())*1000)::float8 AS now`
    return time.parse(rows[0]?.now)
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
    sessionId: string,
    binding: ControlSessionBinding,
  ): Promise<Current | null> {
    // The observer owns account SHARE -> session UPDATE, without touching last_seen_at.
    const first = await this.observe(tx, sessionId)
    if (first === null) return null
    const accounts = await tx<
      AccountSessionState[]
    >`SELECT id,session_version::float8 AS "sessionVersion",disabled FROM farm.session_accounts WHERE id=(SELECT account_id FROM farm.account_sessions WHERE id=${sessionId})`
    const sessions = await tx<
      SessionRecord[]
    >`SELECT id,account_id AS "accountId",account_version::float8 AS "accountVersion",created_at::float8 AS "createdAt",last_seen_at::float8 AS "lastSeenAt",absolute_expires_at::float8 AS "absoluteExpiresAt",revoked_at::float8 AS "revokedAt" FROM farm.account_sessions WHERE id=${sessionId}`
    const account = accounts[0],
      session = sessions[0]
    if (!account || !session) return null
    const initial = evaluateSession(
      sessionId,
      session,
      account,
      first,
      this.config,
    )
    if (
      !initial.ok ||
      initial.accountId !== binding.account_id ||
      binding.origin !== this.config.origin ||
      binding.audience !== this.config.audience
    )
      return null
    const members =
      await tx`SELECT role,revoked_at FROM farm.memberships WHERE farm_id=${binding.farm_id}::uuid AND account_id=${initial.accountId} FOR SHARE`
    const member = members[0]
    if (
      !member ||
      member.revoked_at !== null ||
      !['owner', 'admin', 'operator'].includes(member.role)
    )
      return null
    const role = z.enum(['owner', 'admin', 'operator']).parse(member.role)
    const keys =
      await tx`SELECT status,public_key,thumbprint,approved_at,revoked_at FROM farm.browser_device_keys WHERE key_id=${binding.key_id}::uuid AND farm_id=${binding.farm_id}::uuid AND account_id=${initial.accountId} FOR SHARE`
    const key = keys[0]
    if (
      !key ||
      key.status !== 'approved' ||
      key.approved_at === null ||
      key.revoked_at !== null ||
      key.thumbprint !== binding.browser_thumbprint ||
      canonicalize(BrowserDevicePublicKey.parse(key.public_key)) !==
        canonicalize(binding.browser_public_key)
    )
      return null
    const enrollments =
      await tx`SELECT farm_id,status,public_key_spki,fingerprint FROM farm.connector_enrollments WHERE agent_id=${binding.agent_id}::uuid FOR SHARE`
    const enrollment = enrollments[0]
    if (
      !enrollment ||
      enrollment.status !== 'approved' ||
      enrollment.farm_id !== binding.farm_id ||
      enrollment.public_key_spki !== binding.connector_public_key_spki ||
      enrollment.fingerprint !== binding.connector_fingerprint
    )
      return null
    const credentials = await readPauseAuthorityCredentialRecords(
      tx,
      binding.agent_id,
      binding.credential_jti,
    )
    const credential = credentials[0]
    if (
      !credential ||
      credential.farm_id !== binding.farm_id ||
      credential.fingerprint !== binding.connector_fingerprint ||
      credential.issuer !== this.config.credentialIssuer ||
      credential.audience !== this.config.credentialAudience
    )
      return null
    const slots =
      await tx`SELECT observed_at::float8 AS observed_at,credential_expired_at::float8 AS credential_expired_at FROM farm.connector_credential_proofs WHERE jti=${binding.credential_jti}::uuid FOR SHARE`
    const revoked =
      await tx`SELECT agent_id FROM farm.connector_revocations WHERE agent_id=${binding.agent_id}::uuid OR credential_jti=${binding.credential_jti}::uuid`
    if (
      revoked.length ||
      (slots[0]?.credential_expired_at !== undefined &&
        slots[0].credential_expired_at !== null)
    )
      return null
    const assignments =
      await tx`SELECT farm_id,agent_id,printer_key,revoked_at FROM farm.printer_assignments WHERE id=${binding.assignment_id}::uuid FOR SHARE`
    const assignment = assignments[0]
    if (
      !assignment ||
      assignment.revoked_at !== null ||
      assignment.farm_id !== binding.farm_id ||
      assignment.agent_id !== binding.agent_id
    )
      return null
    const observed = await this.observe(tx, sessionId)
    if (
      observed === null ||
      observed < first ||
      !evaluateSession(sessionId, session, account, observed, this.config).ok ||
      (slots[0] && slots[0].observed_at > observed)
    )
      return null
    const issued = time.parse(credential.issued_at * 1000),
      credentialExpiresAt = time.parse(credential.expires_at * 1000)
    if (
      issued > observed ||
      credentialExpiresAt <= observed ||
      binding.issued_at > observed ||
      binding.expires_at <= observed
    )
      return null
    const connectorKey = await crypto.subtle.importKey(
      'spki',
      new Uint8Array(decodeBase64url(binding.connector_public_key_spki, 44)),
      { name: 'Ed25519' },
      true,
      ['verify'],
    )
    const jwk = await crypto.subtle.exportKey('jwk', connectorKey)
    const thumbprint = base64url(
      new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(
            canonicalize({ crv: 'Ed25519', kty: 'OKP', x: jwk.x }),
          ),
        ),
      ),
    )
    if (thumbprint !== credential.thumbprint) return null
    const validUntil = Math.min(
      session.absoluteExpiresAt,
      session.lastSeenAt + this.config.idleTimeoutMs,
      credentialExpiresAt,
      binding.expires_at,
    )
    if (!Number.isSafeInteger(validUntil) || observed >= validUntil) return null
    return {
      account,
      session,
      role,
      credentialExpiresAt,
      validUntil,
      printerKey: PauseCapabilityV1.shape.printer_key.parse(
        assignment.printer_key,
      ),
    }
  }
  private async validAt(
    tx: TransactionSql,
    sessionId: string,
    current: Current,
    binding: ControlSessionBinding,
    notBefore: number,
  ): Promise<number | null> {
    const observed = await this.observe(tx, sessionId)
    if (
      observed === null ||
      observed < notBefore ||
      observed >= current.validUntil ||
      observed < binding.issued_at ||
      !evaluateSession(
        sessionId,
        current.session,
        current.account,
        observed,
        this.config,
      ).ok
    )
      return null
    return observed
  }
  private async watermark(tx: TransactionSql): Promise<number | null> {
    const rows =
      await tx`SELECT observed_at::float8 AS observed_at FROM farm.pause_authority_watermark WHERE id=1 FOR UPDATE`
    const previous = time.parse(rows[0]?.observed_at),
      now = await this.now(tx)
    if (now < previous) return null
    await tx`UPDATE farm.pause_authority_watermark SET observed_at=${now} WHERE id=1`
    return now
  }
  private async terminal(
    tx: TransactionSql,
    row: ChallengeRow,
    status: 'expired' | 'rejected',
    now: number,
  ): Promise<void> {
    if (now < row.issued_at) return
    await tx`UPDATE farm.pause_authority_challenges SET status=${status},consumed_at=${now},retain_until=greatest(${now},expires_at,binding_expires_at,credential_expires_at)+3600000 WHERE challenge_id=${row.challenge_id}::uuid AND status='pending'`
  }
  async issueChallenge(input: unknown): Promise<PauseChallengeDecision> {
    const parsed = ChallengeInput.safeParse(input)
    if (!parsed.success) return { ok: false, reason: 'invalid-input' }
    let binding: ControlSessionBinding,
      browserSignature: string,
      connectorSignature: string
    try {
      const browser = decodeControlProof(parsed.data.request.browserProofWire),
        connector = decodeControlProof(parsed.data.request.connectorProofWire)
      if (
        browser.role !== 'browser' ||
        connector.role !== 'connector' ||
        canonicalize(browser.binding) !== canonicalize(connector.binding)
      )
        return { ok: false, reason: 'invalid-input' }
      binding = browser.binding
      browserSignature = browser.signature
      connectorSignature = connector.signature
    } catch {
      return { ok: false, reason: 'invalid-input' }
    }
    if (!(await this.validConfiguration()))
      return { ok: false, reason: 'invalid-input' }
    const { sessionRecordId, request } = parsed.data
    return this.transaction(
      async (tx, setDeliveryDeadline): Promise<PauseChallengeDecision> => {
        const current = await this.current(tx, sessionRecordId, binding)
        if (!current) {
          await this.observe(tx, sessionRecordId)
          return denied()
        }
        const before = await this.now(tx)
        const browserValid = await verifyControlSessionProof(
          binding,
          'browser',
          browserSignature,
        )
        const connectorValid = await verifyControlSessionProof(
          binding,
          'connector',
          connectorSignature,
        )
        const afterCrypto = await this.validAt(
          tx,
          sessionRecordId,
          current,
          binding,
          before,
        )
        if (!browserValid || !connectorValid || afterCrypto === null)
          return denied()
        const observed = await this.watermark(tx)
        if (observed === null) return denied()
        await tx`SELECT farm.prune_pause_authority()`
        const budgets =
          await tx`SELECT window_started_at::float8 AS window_started_at,attempts FROM farm.pause_authority_sessions WHERE session_id=${sessionRecordId} FOR UPDATE`
        const prior = budgets[0]
        if (prior && observed < prior.window_started_at) return denied()
        if (
          prior &&
          observed - prior.window_started_at < 900000 &&
          prior.attempts >= 60
        )
          return { ok: false, reason: 'rate-limited' }
        const existing =
          await tx`SELECT challenge_id FROM farm.pause_authority_challenges WHERE transport_id=${binding.transport_id}::uuid OR (agent_id=${binding.agent_id}::uuid AND credential_jti=${binding.credential_jti}::uuid AND admission_nonce=${request.admissionNonce}) FOR UPDATE`
        if (existing.length) return denied()
        const counts =
          await tx`SELECT count(*)::int AS total,count(*) FILTER(WHERE account_id=${current.account.id})::int AS account FROM farm.pause_authority_challenges`
        if (counts[0]?.total >= 4096 || counts[0]?.account >= 64)
          return { ok: false, reason: 'capacity' }
        const now = await this.validAt(
          tx,
          sessionRecordId,
          current,
          binding,
          observed,
        )
        if (now === null) return denied()
        const expires = Math.min(
          now + this.policy.admissionMs,
          current.validUntil,
        )
        if (expires <= now) return denied()
        const challenge = PauseAdmissionChallenge.parse({
          v: 1,
          purpose: 'pause-admission',
          challenge_id: randomUUID(),
          farm_id: binding.farm_id,
          agent_id: binding.agent_id,
          key_id: binding.key_id,
          assignment_id: binding.assignment_id,
          transport_id: binding.transport_id,
          account_id: current.account.id,
          browser_thumbprint: binding.browser_thumbprint,
          origin: this.config.origin,
          audience: this.config.audience,
          control_binding_sha256: await controlBindingHash(binding),
          admission_nonce: request.admissionNonce,
          issued_at: now,
          expires_at: expires,
        })
        await tx`INSERT INTO farm.pause_authority_challenges(challenge_id,session_id,account_id,farm_id,agent_id,key_id,credential_jti,assignment_id,transport_id,admission_nonce,binding,challenge,issued_at,expires_at,binding_expires_at,credential_expires_at) VALUES(${challenge.challenge_id}::uuid,${sessionRecordId},${current.account.id},${binding.farm_id}::uuid,${binding.agent_id}::uuid,${binding.key_id}::uuid,${binding.credential_jti}::uuid,${binding.assignment_id}::uuid,${binding.transport_id}::uuid,${request.admissionNonce},${tx.json(binding)},${tx.json(challenge)},${now},${expires},${binding.expires_at},${current.credentialExpiresAt})`
        if (!prior)
          await tx`INSERT INTO farm.pause_authority_sessions(session_id,window_started_at,attempts) VALUES(${sessionRecordId},${now},1)`
        else if (now - prior.window_started_at >= 900000)
          await tx`UPDATE farm.pause_authority_sessions SET window_started_at=${now},attempts=1 WHERE session_id=${sessionRecordId}`
        else
          await tx`UPDATE farm.pause_authority_sessions SET attempts=attempts+1 WHERE session_id=${sessionRecordId}`
        const final = await this.validAt(
          tx,
          sessionRecordId,
          current,
          binding,
          now,
        )
        if (final === null || final >= expires) {
          await this.terminal(
            tx,
            {
              challenge_id: challenge.challenge_id,
              session_id: sessionRecordId,
              account_id: current.account.id,
              binding,
              challenge,
              status: 'pending',
              issued_at: now,
              expires_at: expires,
            },
            'expired',
            await this.now(tx),
          )
          return denied()
        }
        await tx`UPDATE farm.pause_authority_watermark SET observed_at=${final} WHERE id=1`
        const preCommit = await this.validAt(
          tx,
          sessionRecordId,
          current,
          binding,
          final,
        )
        if (preCommit === null || preCommit >= expires) {
          await this.terminal(
            tx,
            {
              challenge_id: challenge.challenge_id,
              session_id: sessionRecordId,
              account_id: current.account.id,
              binding,
              challenge,
              status: 'pending',
              issued_at: now,
              expires_at: expires,
            },
            'expired',
            await this.now(tx),
          )
          return denied()
        }
        setDeliveryDeadline(challenge.expires_at)
        return { ok: true, challenge }
      },
    )
  }
  async issueCapability(input: unknown): Promise<PauseCapabilityDecision> {
    const parsed = CapabilityInput.safeParse(input)
    if (!parsed.success) return { ok: false, reason: 'invalid-input' }
    let proof: ReturnType<typeof decodePauseAdmissionProof>
    try {
      proof = decodePauseAdmissionProof(parsed.data.request.admissionProofWire)
    } catch {
      return { ok: false, reason: 'invalid-input' }
    }
    if (!(await this.validConfiguration()))
      return { ok: false, reason: 'invalid-input' }
    const { sessionRecordId } = parsed.data
    return this.transaction(
      async (tx, setDeliveryDeadline): Promise<PauseCapabilityDecision> => {
        // Immutable scope is a hint only until the row is locked below.
        const scopes = await tx<
          ChallengeRow[]
        >`SELECT challenge_id,session_id,account_id,binding,challenge,status,issued_at::float8 AS issued_at,expires_at::float8 AS expires_at FROM farm.pause_authority_challenges WHERE challenge_id=${proof.challenge.challenge_id}::uuid`
        const scope = scopes[0]
        if (!scope || scope.session_id !== sessionRecordId) return denied()
        const binding = ControlSessionBinding.parse(scope.binding)
        const current = await this.current(tx, sessionRecordId, binding)
        const watermark = await this.watermark(tx)
        if (watermark === null) return denied()
        const rows = await tx<
          ChallengeRow[]
        >`SELECT challenge_id,session_id,account_id,binding,challenge,status,issued_at::float8 AS issued_at,expires_at::float8 AS expires_at FROM farm.pause_authority_challenges WHERE challenge_id=${scope.challenge_id}::uuid FOR UPDATE`
        const row = rows[0]
        if (
          !row ||
          row.status !== 'pending' ||
          row.session_id !== sessionRecordId ||
          row.account_id !== scope.account_id ||
          canonicalize(row.binding) !== canonicalize(binding)
        )
          return denied()
        const stored = PauseAdmissionChallenge.parse(row.challenge)
        const now = await this.now(tx)
        if (now < watermark || now < row.issued_at) return denied()
        if (!current || now >= row.expires_at) {
          await this.observe(tx, sessionRecordId)
          await this.terminal(
            tx,
            row,
            now >= row.expires_at ? 'expired' : 'rejected',
            await this.now(tx),
          )
          return denied()
        }
        if (canonicalize(stored) !== canonicalize(proof.challenge)) {
          await this.terminal(tx, row, 'rejected', now)
          return denied()
        }
        const validProof = await verifyPauseAdmissionProof(
          proof,
          binding.browser_public_key,
        )
        const checked = await this.validAt(
          tx,
          sessionRecordId,
          current,
          binding,
          now,
        )
        if (!validProof || checked === null || checked >= row.expires_at) {
          await this.terminal(
            tx,
            row,
            checked === null || checked >= row.expires_at
              ? 'expired'
              : 'rejected',
            await this.now(tx),
          )
          return denied()
        }
        let capability: SignedPauseCapabilityV1 | undefined
        try {
          await tx.savepoint(async (save) => {
            const preSign = await this.validAt(
              save,
              sessionRecordId,
              current,
              binding,
              checked,
            )
            if (preSign === null || preSign >= row.expires_at)
              throw new ExpiredIssuance()
            const expires = Math.min(
              preSign + this.policy.capabilityMs,
              current.validUntil,
            )
            if (expires <= preSign) throw new ExpiredIssuance()
            const claims = PauseCapabilityV1.parse({
              v: 1,
              purpose: 'pause-authority',
              capability_id: randomUUID(),
              kid: this.config.kid,
              issuer: this.config.issuer,
              audience: this.config.audience,
              origin: this.config.origin,
              issued_at: preSign,
              expires_at: expires,
              account_id: current.account.id,
              role: current.role,
              farm_id: binding.farm_id,
              agent_id: binding.agent_id,
              key_id: binding.key_id,
              assignment_id: binding.assignment_id,
              transport_id: binding.transport_id,
              browser_public_key: binding.browser_public_key,
              browser_thumbprint: binding.browser_thumbprint,
              connector_fingerprint: binding.connector_fingerprint,
              credential_jti: binding.credential_jti,
              printer_key: current.printerKey,
              control_binding_sha256: stored.control_binding_sha256,
              admission_nonce: stored.admission_nonce,
              actions: ['pause'],
            })
            const signed = await signPauseCapability(claims, this.signingKey)
            const postSign = await this.validAt(
              save,
              sessionRecordId,
              current,
              binding,
              preSign,
            )
            if (
              postSign === null ||
              postSign >= row.expires_at ||
              postSign >= expires
            )
              throw new ExpiredIssuance()
            const wire = encodePauseCapability(signed)
            const hash = base64url(
              new Uint8Array(
                await crypto.subtle.digest(
                  'SHA-256',
                  new TextEncoder().encode(wire),
                ),
              ),
            )
            await save`UPDATE farm.pause_authority_challenges SET status='issued',consumed_at=${postSign},capability_id=${signed.capability_id}::uuid,capability=${save.json(signed)},capability_hash=${hash},capability_expires_at=${expires},retain_until=greatest(${postSign},expires_at,binding_expires_at,credential_expires_at,${expires})+3600000 WHERE challenge_id=${row.challenge_id}::uuid`
            const final = await this.validAt(
              save,
              sessionRecordId,
              current,
              binding,
              postSign,
            )
            if (final === null || final >= row.expires_at || final >= expires)
              throw new ExpiredIssuance()
            await save`UPDATE farm.pause_authority_watermark SET observed_at=${final} WHERE id=1`
            const preCommit = await this.validAt(
              save,
              sessionRecordId,
              current,
              binding,
              final,
            )
            if (
              preCommit === null ||
              preCommit >= row.expires_at ||
              preCommit >= expires
            )
              throw new ExpiredIssuance()
            capability = signed
          })
        } catch (error) {
          await this.observe(tx, sessionRecordId)
          await this.terminal(
            tx,
            row,
            error instanceof ExpiredIssuance ? 'expired' : 'rejected',
            await this.now(tx),
          )
          return error instanceof ExpiredIssuance
            ? denied()
            : { ok: false, reason: 'storage-unavailable' }
        }
        if (capability)
          setDeliveryDeadline(Math.min(row.expires_at, capability.expires_at))
        return capability ? { ok: true, capability } : denied()
      },
    )
  }
}
