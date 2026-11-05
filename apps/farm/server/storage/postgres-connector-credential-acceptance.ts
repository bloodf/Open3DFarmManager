import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto'
import type { Sql } from 'postgres'
import {
  CredentialProofChallenge,
  CredentialProofCompletion,
  CredentialProofPurpose,
  CredentialProofRequest,
  credentialProofPayload,
} from '../../../../packages/farm-protocol/src/credential-proof.ts'
import { PairingProofOrigin } from '../../../../packages/farm-protocol/src/pairing-proof.ts'
import { canonicalize } from '@open3dfarmmanager/farm-protocol'
import { verifyConnectorCredential } from '../utils/connector-credentials.ts'

export interface CredentialAcceptanceConfig {
  issuer: string
  audience: string
  origin: string
  purpose: CredentialProofPurpose
  publicKeys: ReadonlyMap<string, CryptoKey>
  ttlSeconds: number
  proofTtlMs: number
}
export type CredentialAcceptanceDecision =
  | { ok: true; kind: 'challenge'; challenge: CredentialProofChallenge }
  | {
      ok: true
      kind: 'accepted'
      agentId: string
      farmId: string
      jti: string
      connectionId: string
      purpose: CredentialProofPurpose
      acceptedAt: number
      expiresAt: number
    }
  | { ok: false; reason: 'busy'; retryAfterMs: number }
  | { ok: false; reason: 'invalid-input' | 'denied' | 'storage-unavailable' }
interface Credential {
  jti: string
  agent_id: string
  farm_id: string
  fingerprint: string
  thumbprint: string
  kid: string
  issuer: string
  audience: string
  issued_at: number
  expires_at: number
}
interface Slot {
  jti: string
  observed_at: number
  credential_expired_at: number | null
  generation: number
  status: 'idle' | 'pending' | 'consumed' | 'expired' | 'rejected'
  nonce: string | null
  connection_id: string | null
  token_hash: string | null
  origin: string | null
  audience: string | null
  purpose: CredentialProofPurpose | null
  issued_at: number | null
  expires_at: number | null
  next_attempt_at: number
  failures: number
  consumed_at: number | null
}
const deny = {
  ok: false,
  reason: 'denied',
} satisfies CredentialAcceptanceDecision
const busy = (retryAfterMs: number): CredentialAcceptanceDecision => ({
  ok: false,
  reason: 'busy',
  retryAfterMs: Math.max(1, Math.min(60000, retryAfterMs)),
})

/** Internal transaction boundary, not a transport lease or command permission. Caller owns its pool. */
export class PostgresConnectorCredentialAcceptance {
  private readonly config: CredentialAcceptanceConfig
  private inflight = 0
  constructor(
    private readonly sql: Sql,
    config: CredentialAcceptanceConfig,
    private readonly clock: () => number = Date.now,
  ) {
    if (
      !config.issuer ||
      config.issuer.length > 256 ||
      !config.audience ||
      config.audience.length > 256 ||
      !Number.isSafeInteger(config.ttlSeconds) ||
      config.ttlSeconds < 1 ||
      config.ttlSeconds > 3600 ||
      !Number.isSafeInteger(config.proofTtlMs) ||
      config.proofTtlMs < 1 ||
      config.proofTtlMs > 60000 ||
      config.publicKeys.size < 1 ||
      config.publicKeys.size > 16
    )
      throw new Error('Invalid credential acceptance configuration')
    this.config = {
      ...config,
      origin: PairingProofOrigin.parse(config.origin),
      purpose: CredentialProofPurpose.parse(config.purpose),
      publicKeys: new Map(config.publicKeys),
    }
  }
  private now(): number {
    const now = this.clock()
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      now > Number.MAX_SAFE_INTEGER - 61000
    )
      throw new Error('Invalid credential acceptance clock')
    return now
  }
  /** connectionId is generated and owned by the trusted server/transport caller. */
  issue(input: unknown): Promise<CredentialAcceptanceDecision> {
    return this.process(input, false)
  }
  accept(input: unknown): Promise<CredentialAcceptanceDecision> {
    return this.process(input, true)
  }
  private async process(
    input: unknown,
    completion: boolean,
  ): Promise<CredentialAcceptanceDecision> {
    const proof = completion ? CredentialProofCompletion.safeParse(input) : null
    const parsed = proof ?? CredentialProofRequest.safeParse(input)
    if (!parsed.success) return { ok: false, reason: 'invalid-input' }
    const request = parsed.data
    if (this.inflight >= 32) return busy(1000)
    this.inflight++
    let lastCheckedAt = 0
    const readNow = () => {
      const value = this.now()
      lastCheckedAt = Math.max(lastCheckedAt, value)
      return value
    }
    try {
      const decision = await this.sql.begin(
        async (tx): Promise<CredentialAcceptanceDecision> => {
          await tx`SET LOCAL statement_timeout='2000ms'`
          await tx`SET LOCAL lock_timeout='1000ms'`
          // Revocation locks pairing -> enrollment -> credential. Never acquire pairing here.
          const enrollment = (
            await tx`SELECT agent_id,farm_id,status,public_key_spki,fingerprint FROM farm.connector_enrollments WHERE agent_id=${request.agentId}::uuid AND farm_id=${request.farmId}::uuid FOR SHARE`
          )[0]
          if (!enrollment || enrollment.status !== 'approved') return deny
          const credential = (
            await tx<
              Credential[]
            >`SELECT jti,agent_id,farm_id,fingerprint,thumbprint,kid,issuer,audience,issued_at::float8,expires_at::float8 FROM farm.connector_credentials WHERE agent_id=${request.agentId}::uuid FOR SHARE`
          )[0]
          if (
            !credential ||
            credential.farm_id !== request.farmId ||
            credential.fingerprint !== enrollment.fingerprint ||
            credential.issuer !== this.config.issuer ||
            credential.audience !== this.config.audience ||
            credential.expires_at - credential.issued_at !==
              this.config.ttlSeconds
          )
            return deny
          const revoked =
            await tx`SELECT agent_id FROM farm.connector_revocations WHERE agent_id=${request.agentId}::uuid`
          if (revoked.length) return deny
          const firstNow = readNow()
          await tx`INSERT INTO farm.connector_credential_proofs (jti,observed_at,next_attempt_at) VALUES (${credential.jti}::uuid,${firstNow},${firstNow}) ON CONFLICT (jti) DO NOTHING`
          const slot = (
            await tx<
              Slot[]
            >`SELECT jti,observed_at::float8,credential_expired_at::float8,generation::float8,status,nonce,connection_id,token_hash,origin,audience,purpose,issued_at::float8,expires_at::float8,next_attempt_at::float8,failures,consumed_at::float8 FROM farm.connector_credential_proofs WHERE jti=${credential.jti}::uuid FOR UPDATE`
          )[0]
          if (!slot) throw new Error('Missing credential proof slot')
          const now = readNow()
          if (now < firstNow || now < slot.observed_at) return deny
          await tx`UPDATE farm.connector_credential_proofs SET observed_at=${now} WHERE jti=${credential.jti}::uuid`
          const expireCredential = async (observedAt: number) => {
            await tx`UPDATE farm.connector_credential_proofs SET observed_at=${observedAt},credential_expired_at=coalesce(credential_expired_at,${observedAt}),status=CASE WHEN status='pending' THEN 'expired' ELSE status END,consumed_at=CASE WHEN status='pending' THEN ${observedAt} ELSE consumed_at END WHERE jti=${credential.jti}::uuid`
          }
          if (
            slot.credential_expired_at !== null ||
            credential.expires_at * 1000 <= now
          ) {
            if (slot.credential_expired_at === null) await expireCredential(now)
            return deny
          }
          if (now < slot.next_attempt_at)
            return busy(slot.next_attempt_at - now)
          // Bound active cryptographic transactions across processes, without allocating per-request rows.
          const admission =
            await tx`SELECT n FROM generate_series(0,31) n WHERE pg_try_advisory_xact_lock(1870014,n) LIMIT 1`
          if (!admission.length) return busy(1000)
          const publicKey = this.config.publicKeys.get(credential.kid)
          if (!publicKey) return deny
          let claims: Awaited<ReturnType<typeof verifyConnectorCredential>>
          try {
            claims = await verifyConnectorCredential({
              token: request.token,
              issuer: this.config.issuer,
              audience: this.config.audience,
              publicKeys: new Map([[credential.kid, publicKey]]),
              ttlSeconds: this.config.ttlSeconds,
              nowSeconds: Math.floor(now / 1000),
              agentId: request.agentId,
              farmId: request.farmId,
              publicKeySpki: enrollment.public_key_spki,
            })
          } catch {
            return deny
          }
          const verifiedAt = readNow()
          if (verifiedAt < now) return deny
          if (credential.expires_at * 1000 <= verifiedAt) {
            await expireCredential(verifiedAt)
            return deny
          }
          await tx`UPDATE farm.connector_credential_proofs SET observed_at=${verifiedAt},next_attempt_at=${verifiedAt + 1000} WHERE jti=${credential.jti}::uuid`
          if (
            claims.jti !== credential.jti ||
            claims.agentId !== credential.agent_id ||
            claims.farmId !== credential.farm_id ||
            claims.fingerprint !== credential.fingerprint ||
            claims.thumbprint !== credential.thumbprint ||
            claims.issuedAt !== credential.issued_at ||
            claims.expiresAt !== credential.expires_at
          )
            return deny
          const tokenHash = createHash('sha256')
            .update(request.token)
            .digest('base64url')
          const challengeFor = (state: Slot): CredentialProofChallenge =>
            CredentialProofChallenge.parse({
              v: 1,
              agent_id: request.agentId,
              farm_id: request.farmId,
              jti: credential.jti,
              connection_id: state.connection_id,
              public_key_spki: enrollment.public_key_spki,
              fingerprint: credential.fingerprint,
              thumbprint: credential.thumbprint,
              token_hash: state.token_hash,
              origin: state.origin,
              audience: state.audience,
              purpose: state.purpose,
              generation: state.generation,
              nonce: state.nonce,
              issued_at: state.issued_at,
              expires_at: state.expires_at,
            })
          const sameContext =
            slot.connection_id === request.connectionId &&
            slot.token_hash === tokenHash &&
            slot.origin === this.config.origin &&
            slot.audience === this.config.audience &&
            slot.purpose === this.config.purpose
          const expireProof = async (observedAt: number) => {
            await tx`UPDATE farm.connector_credential_proofs SET observed_at=${observedAt},status='expired',consumed_at=${observedAt} WHERE jti=${credential.jti}::uuid AND status='pending'`
          }
          if (!completion) {
            if (
              slot.status === 'pending' &&
              slot.expires_at !== null &&
              verifiedAt < slot.expires_at
            )
              return sameContext
                ? { ok: true, kind: 'challenge', challenge: challengeFor(slot) }
                : busy(slot.expires_at - verifiedAt)
            if (slot.generation >= Number.MAX_SAFE_INTEGER) return deny
            const expiresAt = Math.min(
              verifiedAt + this.config.proofTtlMs,
              credential.expires_at * 1000,
            )
            const nonce = randomBytes(32).toString('base64url')
            await tx`UPDATE farm.connector_credential_proofs SET generation=generation+1,status='pending',nonce=${nonce},connection_id=${request.connectionId}::uuid,token_hash=${tokenHash},origin=${this.config.origin},audience=${this.config.audience},purpose=${this.config.purpose},issued_at=${verifiedAt},expires_at=${expiresAt},failures=0,consumed_at=NULL WHERE jti=${credential.jti}::uuid`
            const challenge = challengeFor({
              ...slot,
              generation: slot.generation + 1,
              connection_id: request.connectionId,
              token_hash: tokenHash,
              origin: this.config.origin,
              audience: this.config.audience,
              purpose: this.config.purpose,
              nonce,
              issued_at: verifiedAt,
              expires_at: expiresAt,
            })
            const writtenAt = readNow()
            if (writtenAt < verifiedAt)
              throw new Error('Credential proof clock regressed after write')
            if (writtenAt >= credential.expires_at * 1000) {
              await expireCredential(writtenAt)
              return deny
            }
            if (writtenAt >= expiresAt) {
              await expireProof(writtenAt)
              return deny
            }
            await tx`UPDATE farm.connector_credential_proofs SET observed_at=${writtenAt} WHERE jti=${credential.jti}::uuid`
            return { ok: true, kind: 'challenge', challenge }
          }
          if (
            slot.status !== 'pending' ||
            !sameContext ||
            !proof?.success ||
            canonicalize(proof.data.challenge) !==
              canonicalize(challengeFor(slot))
          )
            return deny
          if (slot.expires_at === null || verifiedAt >= slot.expires_at) {
            await expireProof(verifiedAt)
            return deny
          }
          const valid = verify(
            null,
            credentialProofPayload(proof.data.challenge),
            createPublicKey({
              key: Buffer.from(enrollment.public_key_spki, 'base64url'),
              format: 'der',
              type: 'spki',
            }),
            Buffer.from(proof.data.signature, 'base64url'),
          )
          const proofAt = readNow()
          if (proofAt < verifiedAt) return deny
          if (proofAt >= credential.expires_at * 1000) {
            await expireCredential(proofAt)
            return deny
          }
          if (proofAt >= slot.expires_at) {
            await expireProof(proofAt)
            return deny
          }
          await tx`UPDATE farm.connector_credential_proofs SET observed_at=${proofAt} WHERE jti=${credential.jti}::uuid`
          const proofExpiresAt = slot.expires_at
          if (!valid) {
            await tx`UPDATE farm.connector_credential_proofs SET observed_at=${proofAt},failures=failures+1,status=CASE WHEN failures=2 THEN 'rejected' ELSE status END,consumed_at=CASE WHEN failures=2 THEN ${proofAt} ELSE consumed_at END WHERE jti=${credential.jti}::uuid`
            return deny
          }
          // A savepoint permits durable expiry observation after a write that waited in SQL.
          const result = await tx
            .savepoint(async (save) => {
              await save`UPDATE farm.connector_credential_proofs SET observed_at=${proofAt},status='consumed',consumed_at=${proofAt} WHERE jti=${credential.jti}::uuid`
              const writtenAt = readNow()
              if (
                writtenAt < proofAt ||
                writtenAt >= proofExpiresAt ||
                writtenAt >= credential.expires_at * 1000
              )
                throw new AcceptanceDeadline(writtenAt, proofAt)
              await save`UPDATE farm.connector_credential_proofs SET observed_at=${writtenAt} WHERE jti=${credential.jti}::uuid`
              return {
                ok: true,
                kind: 'accepted',
                agentId: request.agentId,
                farmId: request.farmId,
                jti: credential.jti,
                connectionId: request.connectionId,
                purpose: this.config.purpose,
                acceptedAt: writtenAt,
                expiresAt: Math.min(
                  proofExpiresAt,
                  credential.expires_at * 1000,
                ),
              } satisfies CredentialAcceptanceDecision
            })
            .catch(async (error: unknown) => {
              if (!(error instanceof AcceptanceDeadline)) throw error
              if (error.observedAt < error.previousAt) return deny
              if (error.observedAt >= credential.expires_at * 1000)
                await expireCredential(error.observedAt)
              else await expireProof(error.observedAt)
              return deny
            })
          return result
        },
      )
      if (decision.ok) {
        const committedAt = this.now()
        const previousAt = lastCheckedAt
        const expiresAt =
          decision.kind === 'accepted'
            ? decision.expiresAt
            : decision.challenge.expires_at
        if (committedAt < previousAt) return deny
        if (committedAt >= expiresAt) {
          // COMMIT itself can wait. Never deliver an expired result; retain that observation.
          await this.sql.begin(async (tx) => {
            await tx`SET LOCAL statement_timeout='2000ms'`
            await tx`SET LOCAL lock_timeout='1000ms'`
            const jti =
              decision.kind === 'accepted'
                ? decision.jti
                : decision.challenge.jti
            await tx`UPDATE farm.connector_credential_proofs p SET observed_at=greatest(p.observed_at,${committedAt}),credential_expired_at=CASE WHEN c.expires_at*1000<=${committedAt} THEN coalesce(p.credential_expired_at,${committedAt}) ELSE p.credential_expired_at END,status=CASE WHEN p.status='pending' AND p.expires_at<=${committedAt} THEN 'expired' ELSE p.status END,consumed_at=CASE WHEN p.status='pending' AND p.expires_at<=${committedAt} THEN ${committedAt} ELSE p.consumed_at END FROM farm.connector_credentials c WHERE p.jti=${jti}::uuid AND c.jti=p.jti`
          })
          return deny
        }
      }
      return decision
    } catch {
      return { ok: false, reason: 'storage-unavailable' }
    } finally {
      this.inflight--
    }
  }
}
class AcceptanceDeadline extends Error {
  constructor(
    readonly observedAt: number,
    readonly previousAt: number,
  ) {
    super('Credential acceptance deadline passed')
  }
}
