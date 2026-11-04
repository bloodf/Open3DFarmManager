import {
  ConnectorProofChallenges,
  type ConnectorProofBinding,
} from './connector-proof.ts'

export interface EnrollmentScope {
  farmId: string
  agentId: string
}
export interface EnrollmentRecord extends EnrollmentScope {
  status: 'pending' | 'approved' | 'revoked'
  publicKeySpki: string
  fingerprint: string
}
/**
 * Future adapter must read current state and invoke check exactly once while serialized
 * against approval/revocation. Resolve only after the read transaction commits.
 * Revocation is terminal for an agent ID; re-enrollment requires a new ID.
 */
export interface EnrollmentSource {
  withEnrollment(
    scope: EnrollmentScope,
    check: (record: EnrollmentRecord | null) => void,
  ): Promise<void>
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Internal integration only; production approval permissions and transport integration are not implemented. */
export class EnrolledConnectorProof {
  #inflight = new Set<{ connectionId: string; cancelled: boolean }>()
  #source: EnrollmentSource
  #challenges = new ConnectorProofChallenges()
  constructor(source: EnrollmentSource) {
    this.#source = source
  }

  async #check<T>(
    scope: EnrollmentScope,
    connectionId: string,
    operation: (binding: ConnectorProofBinding) => T,
  ): Promise<T | null> {
    const attempt = { connectionId, cancelled: false }
    let checking = true
    let calls = 0
    let result: T | null = null
    let failed = false
    try {
      if (
        ![scope.farmId, scope.agentId, connectionId].every(
          (value) => typeof value === 'string' && uuid.test(value),
        )
      )
        return null
      if (this.#inflight.size >= 1000) return null
      this.#inflight.add(attempt)
      const expected = { farmId: scope.farmId, agentId: scope.agentId }
      await this.#source.withEnrollment({ ...expected }, (record) => {
        if (!checking || attempt.cancelled) return
        calls++
        if (
          calls !== 1 ||
          !record ||
          record.status !== 'approved' ||
          record.farmId !== expected.farmId ||
          record.agentId !== expected.agentId
        ) {
          failed = true
          return
        }
        try {
          result = operation({
            ...expected,
            connectionId,
            publicKeySpki: record.publicKeySpki,
            fingerprint: record.fingerprint,
            revoked: false,
          })
        } catch {
          failed = true
        }
      })
      if (
        attempt.cancelled ||
        calls !== 1 ||
        failed ||
        result === null ||
        result === false
      ) {
        this.#challenges.discardConnection(connectionId)
        return null
      }
      return result
    } catch {
      this.#challenges.discardConnection(connectionId)
      return null
    } finally {
      checking = false
      this.#inflight.delete(attempt)
    }
  }
  /** Connection ID must be generated and owned by the server transport. Caller cannot supply a key. */
  issue(
    scope: EnrollmentScope,
    connectionId: string,
    now: () => number,
    ttlMs: number,
  ): Promise<{ nonce: string; expiresAt: number } | null> {
    return this.#check(scope, connectionId, (binding) =>
      this.#challenges.issue(binding, now(), ttlMs),
    )
  }
  async complete(
    scope: EnrollmentScope,
    connectionId: string,
    nonce: string,
    signature: string,
    now: () => number,
  ): Promise<boolean> {
    return (
      (await this.#check(scope, connectionId, (binding) =>
        this.#challenges.complete(nonce, signature, binding, now()),
      )) === true
    )
  }
  discardConnection(connectionId: string): void {
    for (const attempt of this.#inflight)
      if (attempt.connectionId === connectionId) attempt.cancelled = true
    this.#challenges.discardConnection(connectionId)
  }
}
