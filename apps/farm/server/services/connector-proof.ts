import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto'
import {
  PairingPublicKey,
  decodeBase64url,
} from '@open3dfarmmanager/farm-protocol'

/** Must be loaded from current authorized server state, never copied from proof input. */
export interface ConnectorProofBinding {
  farmId: string
  agentId: string
  connectionId: string
  publicKeySpki: string
  fingerprint: string
  revoked: boolean
}
interface PendingProof {
  binding: ConnectorProofBinding
  expiresAt: number
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
function bindingSnapshot(input: ConnectorProofBinding): ConnectorProofBinding {
  if (
    !input ||
    ![input.farmId, input.agentId, input.connectionId].every(
      (value) => typeof value === 'string' && uuid.test(value),
    ) ||
    input.revoked !== false
  )
    throw new Error('Invalid connector proof binding')
  const spki = PairingPublicKey.parse(input.publicKeySpki)
  const fingerprint =
    'SHA256:' +
    createHash('sha256')
      .update(Buffer.from(spki, 'base64url'))
      .digest('base64url')
  if (input.fingerprint !== fingerprint)
    throw new Error('Invalid connector proof binding')
  return {
    farmId: input.farmId,
    agentId: input.agentId,
    connectionId: input.connectionId,
    publicKeySpki: spki,
    fingerprint,
    revoked: false,
  }
}

/**
 * Single-process, one-attempt challenge registry. Restart discards pending challenges.
 * No endpoint, JWT verification, enrollment approval or authorization grant is implemented.
 */
export class ConnectorProofChallenges {
  #pending = new Map<string, PendingProof>()
  #lastNow = 0
  #capacity: number
  constructor(capacity = 1000) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1000)
      throw new Error('Invalid challenge capacity')
    this.#capacity = capacity
  }
  #advance(now: number): void {
    if (
      !Number.isSafeInteger(now) ||
      now < this.#lastNow ||
      now > Number.MAX_SAFE_INTEGER - 60_000
    )
      throw new Error('Invalid challenge clock')
    this.#lastNow = now
    for (const [nonce, row] of this.#pending)
      if (row.expiresAt <= now) this.#pending.delete(nonce)
  }
  /** ttlMs is explicitly supplied by the caller; its cap is unrelated to offline authorization. */
  issue(
    binding: ConnectorProofBinding,
    now: number,
    ttlMs: number,
  ): { nonce: string; expiresAt: number } {
    try {
      this.#advance(now)
      const snapshot = bindingSnapshot(binding)
      if (
        !Number.isSafeInteger(ttlMs) ||
        ttlMs < 1 ||
        ttlMs > 60_000 ||
        this.#pending.size >= this.#capacity
      )
        throw new Error()
      const nonce = randomBytes(32).toString('base64url')
      if (this.#pending.has(nonce)) throw new Error()
      const expiresAt = now + ttlMs
      this.#pending.set(nonce, { binding: snapshot, expiresAt })
      return { nonce, expiresAt }
    } catch {
      throw new Error('Connector proof challenge unavailable')
    }
  }
  /** Valid nonce is consumed on the first attempt, including an invalid signature or changed binding. */
  complete(
    nonce: string,
    signature: string,
    currentBinding: ConnectorProofBinding,
    now: number,
  ): boolean {
    try {
      this.#advance(now)
      if (typeof nonce !== 'string' || nonce.length !== 43) return false
      const pending = this.#pending.get(nonce)
      if (!pending) return false
      this.#pending.delete(nonce)
      const current = bindingSnapshot(currentBinding)
      if (
        Object.keys(current).some(
          (field) =>
            current[field as keyof ConnectorProofBinding] !==
            pending.binding[field as keyof ConnectorProofBinding],
        )
      )
        return false
      if (typeof signature !== 'string' || signature.length !== 86) return false
      const challenge = decodeBase64url(nonce, 32)
      const bytes = decodeBase64url(signature, 64)
      const key = createPublicKey({
        key: Buffer.from(current.publicKeySpki, 'base64url'),
        format: 'der',
        type: 'spki',
      })
      if (key.asymmetricKeyType !== 'ed25519') return false
      return verify(
        null,
        Buffer.concat([
          Buffer.from('Open3DFarmManager/connector-proof/v1\0'),
          Buffer.from(challenge),
        ]),
        key,
        bytes,
      )
    } catch {
      return false
    }
  }
  /** Remove every outstanding challenge when a connection closes. */
  discardConnection(connectionId: string): void {
    for (const [nonce, row] of this.#pending)
      if (row.binding.connectionId === connectionId) this.#pending.delete(nonce)
  }
}
