import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify,
} from 'node:crypto'
import type { Sql, TransactionSql } from 'postgres'
import { z } from 'zod'
import { canonicalize } from '../../../../../packages/farm-protocol/src/canonical.ts'
import {
  RenewalRequest,
  RenewalCompletion,
  RenewalChallenge,
  RenewalReservation,
  renewalIntentPayload,
  renewalProofPayload,
  type RenewalIdentity,
  type RenewalDecision,
} from '../../../../../packages/farm-protocol/src/credential-renewal.ts'
import {
  connectorKeyBinding,
  issueConnectorCredential,
  verifyConnectorCredential,
} from '../utils/connector-credentials.ts'
import { readAcceptanceCredentialRecords } from './postgres-connector-credential-record.ts'
import type { ConnectorCredentialRecord } from './connector-credential-record.ts'

export interface RenewalConfig {
  issuer: string
  audience: string
  origin: string
  proofAudience: string
  ttlSeconds: number
  kid: string
  publicKeys: ReadonlyMap<string, CryptoKey>
  privateKeys: ReadonlyMap<string, CryptoKey>
  proofTtlMs: number
}
const Operation = z.object({
  state: z.enum(['OBSERVED', 'RESERVED', 'COMMITTED']),
  parent_observed_at: z.number(),
  parent_expired_at: z.number().nullable(),
  child_observed_at: z.number().nullable(),
  child_expired_at: z.number().nullable(),
  reservation: RenewalReservation.nullable(),
  challenge: RenewalChallenge.nullable(),
  consumed: z.boolean(),
  attempt: z.number().int().nonnegative(),
  committed_child_jti: z.string().nullable(),
  result_token_sha256: z.string().nullable(),
  authorized_at: z.number().nullable(),
})
type Operation = z.infer<typeof Operation>
const denied: RenewalDecision = { kind: 'denied' }
const digest = (s: string) => createHash('sha256').update(s).digest('base64url')
function signature(
  spki: string,
  bytes: Uint8Array,
  value: string,
): Promise<boolean> {
  return new Promise((resolve, reject) =>
    verify(
      null,
      bytes,
      createPublicKey({
        key: Buffer.from(spki, 'base64url'),
        format: 'der',
        type: 'spki',
      }),
      Buffer.from(value, 'base64url'),
      (error, valid) => (error ? reject(error) : resolve(valid)),
    ),
  )
}
class Clock {
  max = 0
  regressed = false
  last = 0
  constructor(read: () => number) {
    this.read = read
    this.tick()
  }
  read: () => number
  tick() {
    const n = this.read()
    if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid clock')
    if (n < this.last) this.regressed = true
    this.last = n
    this.max = Math.max(this.max, n)
    return n
  }
  async wait<T>(run: () => PromiseLike<T>): Promise<T> {
    this.tick()
    try {
      return await run()
    } finally {
      this.tick()
    }
  }
}
class WindowClosed extends Error {}
/** Explicit server-only transaction owner. No key loading, runtime activation or client persistence. */
export class PostgresConnectorCredentialRenewal {
  private active = 0
  private sql: Sql
  private config: RenewalConfig
  private now: () => number
  constructor(sql: Sql, config: RenewalConfig, now: () => number = Date.now) {
    this.sql = sql
    this.config = config
    this.now = now
    if (
      !Number.isInteger(config.ttlSeconds) ||
      config.ttlSeconds < 1 ||
      config.ttlSeconds > 3600 ||
      !Number.isInteger(config.proofTtlMs) ||
      config.proofTtlMs < 1 ||
      config.proofTtlMs > 60000
    )
      throw new Error('Invalid renewal configuration')
    new URL(config.origin)
    if (
      !config.issuer ||
      !config.audience ||
      !config.proofAudience ||
      !config.kid
    )
      throw new Error('Invalid renewal binding')
  }
  allocate(value: unknown): Promise<RenewalDecision> {
    return this.process(value, false)
  }
  complete(value: unknown): Promise<RenewalDecision> {
    return this.process(value, true)
  }
  private async process(
    value: unknown,
    completion: boolean,
  ): Promise<RenewalDecision> {
    const parsed = completion ? RenewalCompletion.safeParse(value) : null
    const request = RenewalRequest.safeParse(
      completion ? (parsed?.success ? parsed.data.request : null) : value,
    )
    if (!request.success || (completion && !parsed?.success)) return denied
    if (this.active >= 32) return { kind: 'busy' }
    let clock: Clock
    try {
      clock = new Clock(this.now)
    } catch {
      return { kind: 'unavailable' }
    }
    this.active++
    const req = request.data,
      id = req.mode === 'issue' ? req.identity : req.intent.identity,
      farmId = req.mode === 'issue' ? req.farmId : req.intent.farmId
    const proof = parsed?.success ? parsed.data : undefined
    let authenticated = false,
      parentExpires = 0,
      childExpires: number | undefined
    let deliveryDeadline = 0
    const load = async (tx: TransactionSql) => {
      const rows = await clock.wait(
        () =>
          tx`SELECT state,parent_observed_at::float8,parent_expired_at::float8,child_observed_at::float8,child_expired_at::float8,reservation,challenge,consumed,attempt::float8,committed_child_jti::text,result_token_sha256,authorized_at::float8 FROM farm.connector_credential_renewals WHERE root_jti=${id.rootJti}::uuid AND predecessor_kind=${id.kind} AND predecessor_jti=${id.jti}::uuid AND EXISTS(SELECT 1 FROM farm.connector_credentials identity_root WHERE identity_root.jti=${id.rootJti}::uuid AND identity_root.agent_id=${id.agentId}::uuid) FOR UPDATE`,
      )
      return rows[0] ? Operation.parse(rows[0]) : null
    }
    const observe = async (tx: TransactionSql, child: boolean) => {
      const n = clock.tick()
      const m = clock.max
      if (child) {
        if (childExpires === undefined) throw new Error('Missing exact child')
        await clock.wait(
          () =>
            tx`UPDATE farm.connector_credential_renewals SET child_observed_at=greatest(child_observed_at,${m}),child_expired_at=CASE WHEN ${m}>=${childExpires} THEN coalesce(child_expired_at,${m}) ELSE child_expired_at END WHERE root_jti=${id.rootJti}::uuid AND predecessor_kind=${id.kind} AND predecessor_jti=${id.jti}::uuid AND EXISTS(SELECT 1 FROM farm.connector_credentials identity_root WHERE identity_root.jti=${id.rootJti}::uuid AND identity_root.agent_id=${id.agentId}::uuid) AND state='COMMITTED'`,
        )
      } else
        await clock.wait(
          () =>
            tx`UPDATE farm.connector_credential_renewals SET parent_observed_at=greatest(parent_observed_at,${m}),parent_expired_at=CASE WHEN ${m}>=${parentExpires} THEN coalesce(parent_expired_at,${m}) ELSE parent_expired_at END WHERE root_jti=${id.rootJti}::uuid AND predecessor_kind=${id.kind} AND predecessor_jti=${id.jti}::uuid AND EXISTS(SELECT 1 FROM farm.connector_credentials identity_root WHERE identity_root.jti=${id.rootJti}::uuid AND identity_root.agent_id=${id.agentId}::uuid)`,
        )
      return n
    }
    try {
      const decision = await clock.wait(() =>
        this.sql.begin(async (tx): Promise<RenewalDecision> => {
          await clock.wait(() => tx`SET LOCAL statement_timeout='2000ms'`)
          await clock.wait(() => tx`SET LOCAL lock_timeout='1000ms'`)
          const enrollment = (
            await clock.wait(
              () =>
                tx`SELECT status,farm_id::text,fingerprint,public_key_spki FROM farm.connector_enrollments WHERE agent_id=${id.agentId}::uuid FOR UPDATE`,
            )
          )[0]
          const root = (
            await clock.wait(() =>
              readAcceptanceCredentialRecords(tx, id.agentId),
            )
          )[0]
          if (
            !root ||
            root.jti !== id.rootJti ||
            root.farm_id !== farmId ||
            enrollment?.status !== 'approved' ||
            enrollment.farm_id !== farmId ||
            enrollment.fingerprint !== root.fingerprint
          )
            return denied
          if (
            (
              await clock.wait(
                () =>
                  tx`SELECT agent_id FROM farm.connector_revocations WHERE agent_id=${id.agentId}::uuid`,
              )
            ).length
          )
            return denied
          let parent: ConnectorCredentialRecord = root,
            ordinal = 0
          if (id.kind === 'successor') {
            const row = (
              await clock.wait(
                () =>
                  tx`SELECT jti::text,root_jti::text,kid,issuer,audience,issued_at::float8,expires_at::float8,ordinal FROM farm.connector_credential_successors WHERE jti=${id.jti}::uuid AND root_jti=${id.rootJti}::uuid FOR SHARE`,
              )
            )[0]
            if (!row) return denied
            parent = {
              ...root,
              jti: row.jti,
              kid: row.kid,
              issuer: row.issuer,
              audience: row.audience,
              issued_at: row.issued_at,
              expires_at: row.expires_at,
            }
            ordinal = row.ordinal
          }
          parentExpires = parent.expires_at * 1000
          const spki = z.string().parse(enrollment.public_key_spki)
          const binding = await clock.wait(() => connectorKeyBinding(spki))
          if (
            binding.fingerprint !== parent.fingerprint ||
            binding.thumbprint !== parent.thumbprint
          )
            return denied
          const matches = (
            claims: Awaited<ReturnType<typeof verifyConnectorCredential>>,
          ) =>
            claims.jti === parent.jti &&
            claims.agentId === id.agentId &&
            claims.farmId === farmId &&
            claims.fingerprint === parent.fingerprint &&
            claims.thumbprint === parent.thumbprint &&
            claims.issuedAt === parent.issued_at &&
            claims.expiresAt === parent.expires_at
          const verifyToken = (nowSeconds: number) => {
            if (req.mode !== 'issue') throw new Error('Missing issue token')
            return clock.wait(() =>
              verifyConnectorCredential({
                token: req.token,
                issuer: this.config.issuer,
                audience: this.config.audience,
                ttlSeconds: this.config.ttlSeconds,
                publicKeys: new Map(
                  [...this.config.publicKeys].filter(
                    ([kid]) => kid === parent.kid,
                  ),
                ),
                agentId: id.agentId,
                farmId,
                publicKeySpki: spki,
                nowSeconds,
              }),
            )
          }
          let op: Operation | null = null
          if (req.mode === 'issue') {
            if (
              parent.issuer !== this.config.issuer ||
              parent.audience !== this.config.audience ||
              parent.expires_at - parent.issued_at !== this.config.ttlSeconds
            )
              return denied
            try {
              if (!matches(await verifyToken(parent.issued_at))) return denied
            } catch {
              return denied
            }
          } else {
            if (
              req.intent.origin !== this.config.origin ||
              req.intent.audience !== this.config.proofAudience
            )
              return denied
            const valid = await clock.wait(() =>
              signature(
                spki,
                renewalIntentPayload(req.intent),
                req.identitySignature,
              ),
            )
            if (!valid) return denied
          }
          op = await load(tx)
          if (proof) {
            if (
              !op?.challenge ||
              canonicalize(proof.challenge) !== canonicalize(op.challenge) ||
              proof.challenge.mode !== req.mode ||
              canonicalize(proof.challenge.identity) !== canonicalize(id)
            )
              return denied
            const valid = await clock.wait(() =>
              signature(
                spki,
                renewalProofPayload(proof.challenge),
                proof.signature,
              ),
            )
            if (!valid) return denied
          }
          if (req.mode === 'readback') {
            if (
              !op ||
              op.state !== 'COMMITTED' ||
              !op.reservation ||
              !op.committed_child_jti
            )
              return denied
            const receipt = op
            const child = (
              await clock.wait(
                () =>
                  tx`SELECT jti FROM farm.connector_credential_successors WHERE jti=${receipt.committed_child_jti}::uuid AND root_jti=${id.rootJti}::uuid AND predecessor_jti=${id.jti}::uuid AND EXISTS(SELECT 1 FROM farm.connector_credentials identity_root WHERE identity_root.jti=${id.rootJti}::uuid AND identity_root.agent_id=${id.agentId}::uuid) FOR SHARE`,
              )
            )[0]
            if (!child || op.committed_child_jti !== op.reservation.childJti)
              return denied
            childExpires = op.reservation.expiresAt * 1000
          } else if (!op) {
            await clock.wait(
              () =>
                tx`INSERT INTO farm.connector_credential_renewals(root_jti,predecessor_kind,predecessor_jti,predecessor_successor_jti,parent_observed_at) VALUES(${id.rootJti}::uuid,${id.kind},${id.jti}::uuid,${id.kind === 'successor' ? id.jti : null}::uuid,${clock.max})`,
            )
            op = await load(tx)
          }
          if (!op) throw new Error('Missing renewal observation')
          authenticated = true
          const child = req.mode === 'readback'
          const previous = child ? op.child_observed_at : op.parent_observed_at
          if (previous !== null && clock.last < previous) clock.regressed = true
          await observe(tx, child)
          op = await load(tx)
          if (!op) throw new Error('Missing operation')
          const observedOp = op
          const expired = () =>
            child
              ? observedOp.child_expired_at !== null ||
                clock.max >= (childExpires ?? 0)
              : observedOp.parent_expired_at !== null ||
                clock.max >= parentExpires
          const failTime = async (): Promise<RenewalDecision> => {
            await observe(tx, child)
            return expired() ? { kind: 'expired' } : denied
          }
          if (clock.regressed || expired()) return failTime()
          if (req.mode === 'issue') {
            try {
              if (!matches(await verifyToken(Math.floor(clock.tick() / 1000))))
                return denied
            } catch {
              await observe(tx, false)
              return denied
            }
            if (clock.regressed || expired()) return failTime()
            if (op.state === 'COMMITTED')
              return { kind: 'recovery-required', reason: 'readback-required' }
          }
          if (!proof) {
            if (
              op.challenge &&
              !op.consumed &&
              clock.max < op.challenge.expiresAt
            ) {
              if (op.challenge.mode !== req.mode) return denied
              deliveryDeadline = op.challenge.expiresAt
              await observe(tx, child)
              return { kind: 'challenge', challenge: op.challenge }
            }
            let reservation = op.reservation
            if (!reservation) {
              const issuedAt = Math.floor(clock.tick() / 1000)
              reservation = RenewalReservation.parse({
                childJti: randomUUID(),
                ordinal: ordinal + 1,
                kid: this.config.kid,
                issuer: this.config.issuer,
                audience: this.config.audience,
                issuedAt,
                expiresAt: issuedAt + this.config.ttlSeconds,
                tokenHash: req.mode === 'issue' ? digest(req.token) : '',
                codec: 1,
              })
            }
            if (clock.max >= reservation.expiresAt * 1000)
              return {
                kind: 'recovery-required',
                reason: 'reservation-expired',
              }
            const issuedAt = clock.tick()
            if (
              clock.regressed ||
              clock.max >= (child ? (childExpires ?? 0) : parentExpires) ||
              issuedAt >= reservation.expiresAt * 1000
            )
              return failTime()
            const challenge = RenewalChallenge.parse({
              v: 1,
              mode: req.mode,
              identity: id,
              farmId,
              origin: this.config.origin,
              audience: this.config.proofAudience,
              publicKeySpki: spki,
              ...binding,
              reservation,
              nonce: randomBytes(32).toString('base64url'),
              attempt: op.attempt + 1,
              issuedAt,
              expiresAt: Math.min(
                issuedAt + this.config.proofTtlMs,
                reservation.expiresAt * 1000,
                child ? (childExpires ?? 0) : parentExpires,
              ),
            })
            await clock.wait(
              () =>
                tx`UPDATE farm.connector_credential_renewals SET state=CASE WHEN state='OBSERVED' THEN 'RESERVED' ELSE state END,reservation=${tx.json(reservation)},challenge=${tx.json(challenge)},consumed=false,attempt=${challenge.attempt} WHERE root_jti=${id.rootJti}::uuid AND predecessor_kind=${id.kind} AND predecessor_jti=${id.jti}::uuid AND EXISTS(SELECT 1 FROM farm.connector_credentials identity_root WHERE identity_root.jti=${id.rootJti}::uuid AND identity_root.agent_id=${id.agentId}::uuid)`,
            )
            await observe(tx, child)
            if (
              clock.regressed ||
              expired() ||
              clock.max >= challenge.expiresAt
            )
              return failTime()
            deliveryDeadline = challenge.expiresAt
            return { kind: 'challenge', challenge }
          }
          if (
            op.consumed ||
            !op.reservation ||
            !op.challenge ||
            clock.max >= proof.challenge.expiresAt ||
            clock.max < proof.challenge.issuedAt
          )
            return failTime()
          const reservation = op.reservation
          if (
            req.mode === 'issue' &&
            digest(req.token) !== reservation.tokenHash
          )
            return denied
          const key = this.config.privateKeys.get(reservation.kid),
            publicKey = this.config.publicKeys.get(reservation.kid)
          if (
            !key ||
            !publicKey ||
            reservation.issuer !== this.config.issuer ||
            reservation.audience !== this.config.audience ||
            reservation.expiresAt - reservation.issuedAt !==
              this.config.ttlSeconds
          )
            return {
              kind: 'recovery-required',
              reason: 'signing-context-unavailable',
            }
          let result: RenewalDecision = denied
          try {
            result = await clock.wait(() =>
              tx.savepoint(async (save): Promise<RenewalDecision> => {
                const token = await clock.wait(() =>
                  issueConnectorCredential({
                    issuer: reservation.issuer,
                    audience: reservation.audience,
                    ttlSeconds: reservation.expiresAt - reservation.issuedAt,
                    kid: reservation.kid,
                    privateKey: key,
                    jti: reservation.childJti,
                    nowSeconds: reservation.issuedAt,
                    agentId: id.agentId,
                    farmId,
                    publicKeySpki: spki,
                  }),
                )
                const tokenHash = digest(token)
                const claims = await clock.wait(() =>
                  verifyConnectorCredential({
                    token,
                    issuer: reservation.issuer,
                    audience: reservation.audience,
                    ttlSeconds: this.config.ttlSeconds,
                    publicKeys: new Map([[reservation.kid, publicKey]]),
                    nowSeconds: Math.floor(clock.tick() / 1000),
                    agentId: id.agentId,
                    farmId,
                    publicKeySpki: spki,
                  }),
                )
                if (
                  claims.jti !== reservation.childJti ||
                  claims.issuedAt !== reservation.issuedAt ||
                  claims.expiresAt !== reservation.expiresAt
                )
                  throw new Error('Reconstruction identity mismatch')
                if (
                  req.mode === 'readback' &&
                  tokenHash !== observedOp.result_token_sha256
                )
                  return {
                    kind: 'recovery-required',
                    reason: 'result-mismatch',
                  }
                const timely = () =>
                  !clock.regressed &&
                  !expired() &&
                  clock.max < proof.challenge.expiresAt &&
                  clock.max < reservation.expiresAt * 1000
                if (!timely()) throw new WindowClosed()
                if (req.mode === 'issue') {
                  await clock.wait(
                    () =>
                      save`INSERT INTO farm.connector_credential_successors(jti,root_jti,predecessor_jti,predecessor_successor_jti,ordinal,kid,issuer,audience,issued_at,expires_at) VALUES(${reservation.childJti}::uuid,${id.rootJti}::uuid,${id.jti}::uuid,${id.kind === 'successor' ? id.jti : null}::uuid,${reservation.ordinal},${reservation.kid},${reservation.issuer},${reservation.audience},${reservation.issuedAt},${reservation.expiresAt})`,
                  )
                  await clock.wait(
                    () =>
                      save`UPDATE farm.connector_credential_renewals SET state='COMMITTED',committed_child_jti=${reservation.childJti}::uuid,result_token_sha256=${tokenHash},authorized_at=${clock.max},child_observed_at=${clock.max},consumed=true WHERE root_jti=${id.rootJti}::uuid AND predecessor_kind=${id.kind} AND predecessor_jti=${id.jti}::uuid AND EXISTS(SELECT 1 FROM farm.connector_credentials identity_root WHERE identity_root.jti=${id.rootJti}::uuid AND identity_root.agent_id=${id.agentId}::uuid)`,
                  )
                } else
                  await clock.wait(
                    () =>
                      save`UPDATE farm.connector_credential_renewals SET consumed=true WHERE root_jti=${id.rootJti}::uuid AND predecessor_kind=${id.kind} AND predecessor_jti=${id.jti}::uuid AND EXISTS(SELECT 1 FROM farm.connector_credentials identity_root WHERE identity_root.jti=${id.rootJti}::uuid AND identity_root.agent_id=${id.agentId}::uuid)`,
                  )
                if (!timely()) throw new WindowClosed()
                return {
                  kind: 'credential',
                  identity: id,
                  childJti: reservation.childJti,
                  token,
                  expiresAt: reservation.expiresAt * 1000,
                }
              }),
            )
          } catch (error) {
            await observe(tx, child)
            if (error instanceof WindowClosed) return failTime()
            // Savepoint rollback retained the authenticated observation, never a token.
            return { kind: 'recovery-required', reason: 'completion-failed' }
          }
          await observe(tx, child)
          if (
            clock.regressed ||
            expired() ||
            clock.max >= proof.challenge.expiresAt
          )
            return failTime()
          deliveryDeadline = Math.min(
            proof.challenge.expiresAt,
            reservation.expiresAt * 1000,
            child ? (childExpires ?? 0) : parentExpires,
          )
          return result
        }),
      )
      clock.tick()
      if (
        authenticated &&
        (clock.regressed || clock.max >= deliveryDeadline) &&
        (decision.kind === 'credential' || decision.kind === 'challenge')
      ) {
        // Exact captured identity, not a token hint. No authority is returned on cleanup failure.
        await clock.wait(() =>
          this.sql.begin(async (tx) => {
            await clock.wait(
              () =>
                tx`SELECT predecessor_jti FROM farm.connector_credential_renewals WHERE root_jti=${id.rootJti}::uuid AND predecessor_kind=${id.kind} AND predecessor_jti=${id.jti}::uuid AND EXISTS(SELECT 1 FROM farm.connector_credentials identity_root WHERE identity_root.jti=${id.rootJti}::uuid AND identity_root.agent_id=${id.agentId}::uuid) FOR UPDATE`,
            )
            await observe(tx, req.mode === 'readback')
            if (req.mode === 'issue' && decision.kind === 'credential') {
              childExpires = decision.expiresAt
              await observe(tx, true)
            }
          }),
        )
        return denied
      }
      return decision
    } catch {
      return { kind: 'unavailable' }
    } finally {
      this.active--
    }
  }
}
