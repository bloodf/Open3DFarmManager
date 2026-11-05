import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto'
import type { Sql } from 'postgres'
import { PairingPollRequest } from '@open3dfarmmanager/farm-protocol'
import {
  PAIRING_PROOF_TTL_MS,
  PairingProofAudience,
  PairingProofOrigin,
  PairingProofChallenge,
  PairingProofCompletion,
  pairingProofPayload,
} from '../../../../packages/farm-protocol/src/pairing-proof.ts'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
type Failure = {
  ok: false
  reason: 'invalid-input' | 'denied' | 'capacity' | 'storage-unavailable'
}
type IssueResult =
  | { ok: true; challenge: PairingProofChallenge }
  | { ok: false; reason: 'slow-down'; retryAfterS: 5 }
  | Failure
type CompleteResult =
  | { ok: true; status: 'verified'; agentId: string; fingerprint: string }
  | Failure
interface PairingRow {
  agent_id: string
  public_key_spki: string
  fingerprint: string
  issued_at: number
  expires_at: number
  status: string
}
interface ProofRow {
  attempt: number
  nonce: string
  origin: string
  audience: string
  issued_at: number
  expires_at: number
  next_poll_at: number
  status: 'pending' | 'verified' | 'rejected' | 'expired'
}

/** Internal possession proof only. Does not approve pairing or authenticate a transport. */
export class PostgresPairingProof {
  private readonly origin: string
  private readonly audience: string
  constructor(
    private readonly sql: Sql,
    config: { origin: string; audience: string },
    private readonly clock: () => number = Date.now,
  ) {
    this.origin = PairingProofOrigin.parse(config.origin)
    this.audience = PairingProofAudience.parse(config.audience)
  }
  private now(): number {
    const now = this.clock()
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      now > Number.MAX_SAFE_INTEGER - PAIRING_PROOF_TTL_MS
    )
      throw new Error('Invalid proof clock')
    return now
  }
  private challenge(
    pairing: PairingRow,
    proof: Pick<
      ProofRow,
      'nonce' | 'origin' | 'audience' | 'issued_at' | 'expires_at'
    >,
  ): PairingProofChallenge {
    const key = createPublicKey({
      key: Buffer.from(pairing.public_key_spki, 'base64url'),
      format: 'der',
      type: 'spki',
    })
    const der = key.export({ format: 'der', type: 'spki' })
    if (
      key.asymmetricKeyType !== 'ed25519' ||
      der.toString('base64url') !== pairing.public_key_spki ||
      'SHA256:' + createHash('sha256').update(der).digest('base64url') !==
        pairing.fingerprint
    )
      throw new Error('Invalid persisted pairing identity')
    return PairingProofChallenge.parse({
      v: 1,
      agent_id: pairing.agent_id,
      public_key_spki: pairing.public_key_spki,
      fingerprint: pairing.fingerprint,
      origin: proof.origin,
      audience: proof.audience,
      nonce: proof.nonce,
      issued_at: proof.issued_at,
      expires_at: proof.expires_at,
    })
  }
  /** Requires the unguessable device code. Retries redeliver the same current challenge at most every five seconds. */
  async issue(input: unknown): Promise<IssueResult> {
    const parsed = PairingPollRequest.safeParse(input)
    if (!parsed.success) return { ok: false, reason: 'invalid-input' }
    try {
      return await this.sql.begin(async (tx): Promise<IssueResult> => {
        await tx`SET LOCAL statement_timeout = '2000ms'`
        await tx`SET LOCAL lock_timeout = '1000ms'`
        await tx`SELECT pg_advisory_xact_lock(1870033, 8)`
        const pairings = await tx<
          PairingRow[]
        >`SELECT agent_id, public_key_spki, fingerprint, issued_at::float8, expires_at::float8, status FROM farm.pairing_requests WHERE device_code_hash = ${hash(parsed.data.device_code)} FOR UPDATE`
        const pairing = pairings[0]
        if (!pairing) return { ok: false, reason: 'denied' }
        const proofs = await tx<
          ProofRow[]
        >`SELECT attempt, nonce, origin, audience, issued_at::float8, expires_at::float8, next_poll_at::float8, status FROM farm.pairing_proofs WHERE agent_id = ${pairing.agent_id}::uuid ORDER BY attempt DESC LIMIT 1 FOR UPDATE`
        const proof = proofs[0]
        const now = this.now()
        if (
          pairing.status !== 'pending' ||
          now < pairing.issued_at ||
          now >= pairing.expires_at ||
          (proof &&
            (proof.origin !== this.origin ||
              proof.audience !== this.audience ||
              now < proof.issued_at ||
              proof.status === 'verified'))
        )
          return { ok: false, reason: 'denied' }
        if (proof?.status === 'pending' && now < proof.expires_at) {
          if (now < proof.next_poll_at)
            return { ok: false, reason: 'slow-down', retryAfterS: 5 }
          const challenge = this.challenge(pairing, proof)
          await tx`UPDATE farm.pairing_proofs SET next_poll_at = ${now + 5000} WHERE agent_id = ${pairing.agent_id}::uuid AND attempt = ${proof.attempt}`
          return { ok: true, challenge }
        }
        if (proof && now < proof.issued_at + 5000)
          return { ok: false, reason: 'slow-down', retryAfterS: 5 }
        if (proof?.status === 'pending')
          await tx`UPDATE farm.pairing_proofs SET status = 'expired', consumed_at = ${now} WHERE agent_id = ${pairing.agent_id}::uuid AND attempt = ${proof.attempt}`
        if (proof && proof.attempt >= 3) return { ok: false, reason: 'denied' }
        const active =
          await tx`SELECT count(*)::int AS n FROM farm.pairing_proofs WHERE status = 'pending' AND expires_at > ${now}`
        if (active[0]?.n >= 1000) return { ok: false, reason: 'capacity' }
        const challenge = this.challenge(pairing, {
          origin: this.origin,
          audience: this.audience,
          nonce: randomBytes(32).toString('base64url'),
          issued_at: now,
          expires_at: Math.min(now + PAIRING_PROOF_TTL_MS, pairing.expires_at),
        })
        await tx`INSERT INTO farm.pairing_proofs (agent_id, attempt, nonce, origin, audience, issued_at, expires_at, next_poll_at) VALUES (${pairing.agent_id}::uuid, ${(proof?.attempt ?? 0) + 1}, ${challenge.nonce}, ${this.origin}, ${this.audience}, ${now}, ${challenge.expires_at}, ${now + 5000})`
        return { ok: true, challenge }
      })
    } catch {
      return { ok: false, reason: 'storage-unavailable' }
    }
  }
  /** Exact addressed attempt is consumed even on an invalid signature; unrelated challenge input is not consumed. */
  async complete(input: unknown): Promise<CompleteResult> {
    const parsed = PairingProofCompletion.safeParse(input)
    if (!parsed.success) return { ok: false, reason: 'invalid-input' }
    const request = parsed.data
    try {
      return await this.sql.begin(async (tx): Promise<CompleteResult> => {
        await tx`SET LOCAL statement_timeout = '2000ms'`
        await tx`SET LOCAL lock_timeout = '1000ms'`
        const pairings = await tx<
          PairingRow[]
        >`SELECT agent_id, public_key_spki, fingerprint, issued_at::float8, expires_at::float8, status FROM farm.pairing_requests WHERE device_code_hash = ${hash(request.device_code)} FOR UPDATE`
        const pairing = pairings[0]
        if (!pairing) return { ok: false, reason: 'denied' }
        const proofs = await tx<
          ProofRow[]
        >`SELECT attempt, nonce, origin, audience, issued_at::float8, expires_at::float8, next_poll_at::float8, status FROM farm.pairing_proofs WHERE agent_id = ${pairing.agent_id}::uuid AND nonce = ${request.challenge.nonce} FOR UPDATE`
        const proof = proofs[0]
        const now = this.now()
        if (
          !proof ||
          proof.status !== 'pending' ||
          pairing.status !== 'pending' ||
          proof.origin !== this.origin ||
          proof.audience !== this.audience ||
          now < pairing.issued_at ||
          now < proof.issued_at
        )
          return { ok: false, reason: 'denied' }
        const expected = this.challenge(pairing, proof)
        const payload = pairingProofPayload(expected)
        if (
          !Buffer.from(payload).equals(
            Buffer.from(pairingProofPayload(request.challenge)),
          )
        )
          return { ok: false, reason: 'denied' }
        if (now >= proof.expires_at || now >= pairing.expires_at) {
          await tx`UPDATE farm.pairing_proofs SET status = 'expired', consumed_at = ${now} WHERE agent_id = ${pairing.agent_id}::uuid AND attempt = ${proof.attempt}`
          return { ok: false, reason: 'denied' }
        }
        const key = createPublicKey({
          key: Buffer.from(expected.public_key_spki, 'base64url'),
          format: 'der',
          type: 'spki',
        })
        const valid = verify(
          null,
          payload,
          key,
          Buffer.from(request.signature, 'base64url'),
        )
        // Crypto work and any final scheduling delay cannot extend the deadline.
        const completedAt = this.now()
        const status =
          completedAt < now ||
          completedAt >= proof.expires_at ||
          completedAt >= pairing.expires_at
            ? 'expired'
            : valid
              ? 'verified'
              : 'rejected'
        await tx`UPDATE farm.pairing_proofs SET status = ${status}, consumed_at = ${Math.max(now, completedAt)} WHERE agent_id = ${pairing.agent_id}::uuid AND attempt = ${proof.attempt}`
        return status === 'verified'
          ? {
              ok: true,
              status: 'verified',
              agentId: pairing.agent_id,
              fingerprint: pairing.fingerprint,
            }
          : { ok: false, reason: 'denied' }
      })
    } catch {
      return { ok: false, reason: 'storage-unavailable' }
    }
  }
}
