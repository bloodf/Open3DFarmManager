import {
  configurationBindingFromDescriptions,
  configurationBindingHash,
  decodeConfigurationSessionProof,
  encodeConfigurationSessionProof,
  verifyConfigurationSessionPair,
  type ConfigurationSessionBinding,
} from '../../../farm-protocol/src/configuration-binding.ts'
import {
  decodeConfigurationAdmissionProof,
  decodeConfigurationCapability,
  verifyConfigurationAuthorityEvidence,
} from '../../../farm-protocol/src/configuration-capability.ts'
import { configurationFresh } from '../../../farm-protocol/src/configuration-common.ts'
import {
  decodeConfigurationRequest,
  encodeConfigurationResponse,
  type ConfigurationErrorCode,
  type ConfigurationResponseFrame,
} from '../../../farm-protocol/src/configuration-frames.ts'
import {
  encodeConfigurationReceipt,
  type SignedConfigurationReceipt,
} from '../../../farm-protocol/src/configuration-receipt.ts'
import { ConnectorIdentity } from '../identity/store.ts'
import type { InventoryAcknowledgement } from '../provisioning/authority.ts'
import { errorFrame } from '../provisioning/receipts.ts'
import type { ConfigurationAuthority } from '../runtime/configuration-authority.ts'
import type { ConfigurationIssuerSource } from '../runtime/configuration-issuer.ts'
import {
  decodeBrowserChannelMessage,
  encodeConnectorChannelMessage,
  type BrowserChannelMessage,
} from './configuration-channel.ts'

/** Context the authenticated signalling inbox announced for this transport. */
export interface ConfigurationExpectedContext {
  transportId: string
  farmId: string
  agentId: string
  accountId: string
  keyId: string
  browserThumbprint: string
  credentialJti: string
  connectorNonce: string
}

export type InventoryOutcome =
  | { ok: true; receipt: SignedConfigurationReceipt }
  | {
      ok: false
      reason: 'unknown' | 'mismatch' | 'rejected' | 'busy' | 'not-available'
    }

export interface ConfigurationRequestHandler {
  handle(request: {
    frame: unknown
    context: unknown
  }): Promise<ConfigurationResponseFrame>
  confirmInventory(
    ack: InventoryAcknowledgement,
    attestation: string,
  ): Promise<InventoryOutcome>
}

export interface ConfigurationSessionOptions {
  identity: ConnectorIdentity
  expected: ConfigurationExpectedContext
  issuers: ConfigurationIssuerSource
  authority: ConfigurationAuthority
  handler: ConfigurationRequestHandler
  send: (wire: string) => void
  /** Replay guard for transport IDs and connector nonces (process lifetime). */
  claimFresh: (transportId: string, connectorNonce: string) => boolean
  clock?: () => number
  authDeadlineMs?: number
  skewMs?: number
  onAuthenticated?: (binding: ConfigurationSessionBinding) => void
  onTerminal?: (reason: string) => void
}

type State = 'awaiting-binding' | 'awaiting-proof' | 'authenticated' | 'closed'
const MAX_PENDING = 4

const EXPIRED_REASONS = new Set([
  'capability-expired',
  'binding-expired',
  'admission-expired',
])

/**
 * Connector side of one authenticated config-v1 RTC session. Transport
 * agnostic: the peer supplies the exact negotiated descriptions and the actual
 * remote DTLS fingerprint. Requests are processed one at a time, only after
 * mutual domain-separated proofs over the server-issued binding.
 */
export class ConfigurationConnectorSession {
  readonly closed: Promise<void>
  #options: Readonly<ConfigurationSessionOptions>
  #clock: () => number
  #state: State = 'awaiting-binding'
  #terminal: string | undefined
  #resolveClosed: () => void = () => {}
  #binding: ConfigurationSessionBinding | undefined
  #bindingHash: string | undefined
  #descriptions: { localSdp: string; remoteSdp: string } | undefined
  #ownProof: unknown
  #earlyProof: string | undefined
  #closeTransport: (() => void) | undefined
  #queue: Promise<void> = Promise.resolve()
  #pending = 0
  #authTimer: ReturnType<typeof setTimeout> | undefined
  #lifeTimer: ReturnType<typeof setTimeout> | undefined
  #requests = 0

  constructor(options: ConfigurationSessionOptions) {
    if (!(options.identity instanceof ConnectorIdentity))
      throw new Error('Connector identity required')
    this.#options = Object.freeze({
      ...options,
      expected: Object.freeze({ ...options.expected }),
    })
    this.#clock = options.clock ?? Date.now
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve
    })
    this.#authTimer = setTimeout(
      () => this.close('auth-timeout'),
      options.authDeadlineMs ?? 10_000,
    )
  }

  get state(): State {
    return this.#state
  }
  get requests(): number {
    return this.#requests
  }

  /**
   * Called once by the peer after DTLS completes, with the server-issued
   * binding (from authenticated signalling) and the exact descriptions.
   */
  async activate(
    input: unknown,
    descriptions: { localSdp: string; remoteSdp: string },
    remoteDtls: string,
  ): Promise<void> {
    if (this.#state !== 'awaiting-binding') return this.close('binding-state')
    try {
      const binding = await configurationBindingFromDescriptions(
        input,
        'connector',
        descriptions.localSdp,
        descriptions.remoteSdp,
      )
      const e = this.#options.expected
      const identity = this.#options.identity
      // Origin/audience pins come only from server issuer metadata fetched
      // over the enrolled HTTPS origin, never from the browser or signalling.
      const issuer =
        this.#options.issuers.current() ??
        (await this.#options.issuers.refresh())
      if (
        this.#terminal ||
        remoteDtls.toUpperCase() !== binding.browser_dtls ||
        binding.transport_id !== e.transportId ||
        binding.farm_id !== e.farmId ||
        binding.agent_id !== e.agentId ||
        binding.account_id !== e.accountId ||
        binding.key_id !== e.keyId ||
        binding.browser_thumbprint !== e.browserThumbprint ||
        binding.credential_jti !== e.credentialJti ||
        binding.connector_nonce !== e.connectorNonce ||
        !issuer ||
        binding.origin !== issuer.origin ||
        binding.audience !== issuer.audience ||
        binding.connector_public_key_spki !== identity.publicKeySpki ||
        binding.connector_fingerprint !== identity.fingerprint ||
        !configurationFresh(binding, this.#clock(), this.skew()) ||
        !this.#options.claimFresh(binding.transport_id, binding.connector_nonce)
      )
        return this.close('binding-rejected')
      const proof = await identity.signConfigurationSessionProof({
        binding,
        expectedAgentId: e.agentId,
      })
      if (this.#terminal) return
      this.#binding = binding
      this.#bindingHash = await configurationBindingHash(binding)
      this.#descriptions = { ...descriptions }
      this.#ownProof = proof
      this.#state = 'awaiting-proof'
      this.transmit({
        v: 1,
        t: 'proof',
        proof: encodeConfigurationSessionProof(proof),
      })
      const early = this.#earlyProof
      this.#earlyProof = undefined
      if (early !== undefined) await this.acceptBrowserProof(early)
    } catch {
      this.close('binding-rejected')
    }
  }

  /** Raw channel input; malformed, oversize or out-of-order closes the session. */
  receive(raw: unknown): void {
    if (this.#terminal) return
    let message: BrowserChannelMessage
    try {
      message = decodeBrowserChannelMessage(raw)
    } catch {
      return this.close('protocol-violation')
    }
    if (this.#state === 'awaiting-binding') {
      if (message.t !== 'proof' || this.#earlyProof !== undefined)
        return this.close('protocol-violation')
      this.#earlyProof = message.proof
      return
    }
    if (this.#pending >= MAX_PENDING) return this.close('pending-limit')
    this.#pending++
    this.#queue = this.#queue
      .then(() => this.dispatch(message))
      .catch(() => this.close('handler-failed'))
      .finally(() => {
        this.#pending--
      })
  }

  private skew(): number {
    return Math.min(Math.max(this.#options.skewMs ?? 2000, 0), 5000)
  }

  private async dispatch(message: BrowserChannelMessage): Promise<void> {
    if (this.#terminal) return
    if (message.t === 'proof') {
      if (this.#state !== 'awaiting-proof')
        return this.close('protocol-violation')
      return this.acceptBrowserProof(message.proof)
    }
    if (this.#state !== 'authenticated') return this.close('protocol-violation')
    if (message.t === 'request') return this.request(message)
    return this.inventory(message)
  }

  private async acceptBrowserProof(wire: string): Promise<void> {
    try {
      const proof = decodeConfigurationSessionProof(wire)
      const descriptions = this.#descriptions
      if (proof.role !== 'browser' || !descriptions || !this.#binding)
        return this.close('proof-rejected')
      const verified = await verifyConfigurationSessionPair(
        proof,
        this.#ownProof,
        { role: 'connector', ...descriptions },
      )
      if (
        this.#terminal ||
        !verified ||
        (await configurationBindingHash(verified)) !== this.#bindingHash ||
        !configurationFresh(this.#binding, this.#clock(), this.skew())
      )
        return this.close('proof-rejected')
      this.#closeTransport = this.#options.authority.openTransport(
        this.#binding,
      )
      this.#state = 'authenticated'
      clearTimeout(this.#authTimer)
      this.#lifeTimer = setTimeout(
        () => this.close('binding-expired'),
        Math.max(0, this.#binding.expires_at - this.#clock()),
      )
      this.#options.onAuthenticated?.(this.#binding)
    } catch {
      this.close('proof-rejected')
    }
  }

  private respond(frame: ConfigurationResponseFrame): void {
    this.transmit({
      v: 1,
      t: 'response',
      frame: encodeConfigurationResponse(frame),
    })
  }
  private reject(requestId: string | null, code: ConfigurationErrorCode) {
    this.respond(errorFrame(requestId, code))
  }

  private async request(
    message: Extract<BrowserChannelMessage, { t: 'request' }>,
  ): Promise<void> {
    this.#requests++
    let frame, capability, admission
    try {
      frame = decodeConfigurationRequest(message.frame)
    } catch {
      return this.reject(null, 'invalid-request')
    }
    try {
      capability = decodeConfigurationCapability(message.capability)
      admission = decodeConfigurationAdmissionProof(message.admission)
    } catch {
      return this.reject(frame.request_id, 'capability-rejected')
    }
    const binding = this.#binding
    const issuer = await this.#options.issuers.forKid(capability.kid)
    if (this.#terminal || !binding) return
    if (
      !issuer ||
      capability.origin !== issuer.origin ||
      capability.audience !== issuer.audience
    )
      return this.reject(frame.request_id, 'capability-rejected')
    const evidence = await verifyConfigurationAuthorityEvidence({
      frame,
      capability,
      admission,
      binding,
      issuerKey: issuer.key,
      now: this.#clock(),
      skewMs: this.skew(),
    })
    if (this.#terminal) return
    if (!evidence.ok)
      return this.reject(
        frame.request_id,
        EXPIRED_REASONS.has(evidence.reason)
          ? 'expired'
          : 'capability-rejected',
      )
    const admitted = this.#options.authority.admit(
      evidence,
      binding.transport_id,
    )
    if (!admitted) return this.reject(frame.request_id, 'capability-rejected')
    const response = await this.#options.handler.handle(admitted)
    if (!this.#terminal) this.respond(response)
  }

  private async inventory(
    message: Extract<BrowserChannelMessage, { t: 'inventory' }>,
  ): Promise<void> {
    const outcome = await this.#options.handler.confirmInventory(
      {
        operation_id: message.operation_id,
        local_committed_receipt_sha256: message.local_committed_receipt_sha256,
        committed_revision: message.committed_revision,
      },
      message.attestation,
    )
    if (this.#terminal) return
    this.transmit({
      v: 1,
      t: 'inventory-result',
      operation_id: message.operation_id,
      ok: outcome.ok,
      reason: outcome.ok ? null : outcome.reason,
      receipt: outcome.ok ? encodeConfigurationReceipt(outcome.receipt) : null,
    })
  }

  private transmit(message: unknown): void {
    if (this.#terminal) return
    try {
      this.#options.send(encodeConnectorChannelMessage(message))
    } catch {
      this.close('send-failed')
    }
  }

  close(reason = 'closed'): void {
    if (this.#terminal) return
    this.#terminal = reason.slice(0, 64) || 'closed'
    this.#state = 'closed'
    clearTimeout(this.#authTimer)
    clearTimeout(this.#lifeTimer)
    this.#earlyProof = undefined
    try {
      this.#closeTransport?.()
    } catch {
      /* Authority cleanup is best effort; the transport is already closed. */
    }
    try {
      this.#options.onTerminal?.(this.#terminal)
    } catch {
      /* Observer failures never reopen the session. */
    }
    void this.#queue.finally(() => this.#resolveClosed())
  }

  get terminalReason(): string | undefined {
    return this.#terminal
  }
}
