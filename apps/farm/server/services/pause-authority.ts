import { z } from 'zod'
import type { Sql } from 'postgres'
import { canonicalize } from '../../../../packages/farm-protocol/src/canonical.ts'
import {
  decodeControlProof,
  MAX_CONTROL_PROOF_WIRE_BYTES,
} from '../../../../packages/farm-protocol/src/control-session-binding.ts'
import {
  decodePauseAdmissionProof,
  MAX_PAUSE_ADMISSION_WIRE_BYTES,
  PauseAdmissionChallenge,
  pauseAdmissionPayload,
  SignedPauseCapabilityV1,
  encodePauseCapability,
} from '../../../../packages/farm-protocol/src/pause-capability.ts'
import {
  PostgresPauseAuthority,
  type PauseAuthorityIssuerConfig,
} from '../storage/postgres-pause-authority.ts'

const sessionReference = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const ChallengeInput = z.strictObject({
  sessionRecordId: sessionReference,
  request: z.strictObject({
    browserProofWire: z.string().max(MAX_CONTROL_PROOF_WIRE_BYTES),
    connectorProofWire: z.string().max(MAX_CONTROL_PROOF_WIRE_BYTES),
    admissionNonce: PauseAdmissionChallenge.shape.admission_nonce,
  }),
})
const CapabilityInput = z.strictObject({
  sessionRecordId: sessionReference,
  request: z.strictObject({
    admissionProofWire: z.string().max(MAX_PAUSE_ADMISSION_WIRE_BYTES),
  }),
})
const FailureReason = z.enum([
  'invalid-input',
  'denied',
  'capacity',
  'rate-limited',
  'storage-unavailable',
])
export type PauseAuthorityServiceFailure = {
  ok: false
  reason: z.infer<typeof FailureReason>
}
export type PauseAuthorityChallengeResult =
  | { ok: true; challenge: PauseAdmissionChallenge }
  | PauseAuthorityServiceFailure
export type PauseAuthorityCapabilityResult =
  | { ok: true; capability: SignedPauseCapabilityV1 }
  | PauseAuthorityServiceFailure

// Process-wide admission, including configuration crypto and blocked SQL. No wait list.
let activeOperations = 0
const denied = (): PauseAuthorityServiceFailure => ({
  ok: false,
  reason: 'denied',
})
const invalid = (): PauseAuthorityServiceFailure => ({
  ok: false,
  reason: 'invalid-input',
})

/**
 * Internal fixed-purpose boundary, not authentication or an HTTP handler. sessionRecordId
 * must come from the sealed own-login flow; its shape is not proof of a session. The real
 * PostgreSQL implementation reauthorizes every account, membership, key and assignment.
 * It owns the injected dedicated issuer key, native key-pair ready gate, signing and commit.
 */
export function createPauseAuthorityService(
  sql: Sql,
  config: PauseAuthorityIssuerConfig,
) {
  // Concrete storage only; no browser-supplied key, signer callback or synthetic authority.
  // Its constructor snapshots configuration; neither keys nor internal login IDs are returned.
  const storage = new PostgresPauseAuthority(sql, config)
  const issueChallenge = storage.issueChallenge.bind(storage)
  const issueCapability = storage.issueCapability.bind(storage)
  let closed = false

  async function operation<T>(
    action: () => Promise<T>,
  ): Promise<T | PauseAuthorityServiceFailure> {
    if (closed) return denied()
    if (activeOperations >= 8) return { ok: false, reason: 'capacity' }
    activeOperations++
    try {
      // No Promise.race: a slow/hung dependency retains its slot until it actually settles.
      return await action()
    } catch {
      // An unavailable response does not prove that a capability was never committed.
      // Never retry or redeliver automatically; any issued capability keeps its original expiry.
      return { ok: false, reason: 'storage-unavailable' }
    } finally {
      activeOperations--
    }
  }

  return Object.freeze({
    issueChallenge(input: unknown): Promise<PauseAuthorityChallengeResult> {
      return operation<PauseAuthorityChallengeResult>(async () => {
        // Parsing clones all fields before the first await. Caller mutation cannot switch scope.
        const parsed = ChallengeInput.safeParse(input)
        if (!parsed.success) return invalid()
        const request = Object.freeze(parsed.data.request)
        try {
          const browser = decodeControlProof(request.browserProofWire)
          const connector = decodeControlProof(request.connectorProofWire)
          if (
            browser.role !== 'browser' ||
            connector.role !== 'connector' ||
            canonicalize(browser.binding) !== canonicalize(connector.binding)
          )
            return invalid()
        } catch {
          return invalid()
        }
        const result = await issueChallenge(
          Object.freeze({
            sessionRecordId: parsed.data.sessionRecordId,
            request,
          }),
        )
        if (!result.ok)
          return { ok: false, reason: FailureReason.parse(result.reason) }
        const challenge = PauseAdmissionChallenge.parse(result.challenge)
        pauseAdmissionPayload(challenge) // Enforce the maintained UTF-8/domain envelope bound.
        return { ok: true, challenge: Object.freeze(challenge) }
      })
    },
    issueCapability(input: unknown): Promise<PauseAuthorityCapabilityResult> {
      return operation<PauseAuthorityCapabilityResult>(async () => {
        const parsed = CapabilityInput.safeParse(input)
        if (!parsed.success) return invalid()
        const request = Object.freeze(parsed.data.request)
        try {
          decodePauseAdmissionProof(request.admissionProofWire)
        } catch {
          return invalid()
        }
        const result = await issueCapability(
          Object.freeze({
            sessionRecordId: parsed.data.sessionRecordId,
            request,
          }),
        )
        if (!result.ok)
          return { ok: false, reason: FailureReason.parse(result.reason) }
        const capability = SignedPauseCapabilityV1.parse(result.capability)
        encodePauseCapability(capability)
        Object.freeze(capability.browser_public_key)
        Object.freeze(capability.actions)
        return { ok: true, capability: Object.freeze(capability) }
      })
    },
    /**
     * Stops new work only. In-flight storage decisions still finish and are returned as such;
     * closing a service or peer is not offline revocation and does not cancel a committed lease.
     * This service does not own or close the supplied database pool.
     */
    close(): void {
      closed = true
    },
  })
}
