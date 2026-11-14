import type { ConfigurationSessionBinding } from '../../../farm-protocol/src/configuration-binding.ts'
import type { ConfigurationAuthorityEvidence } from '../../../farm-protocol/src/configuration-capability.ts'
import type { ConfigurationRequestFrame } from '../../../farm-protocol/src/configuration-frames.ts'
import {
  decodeConfigurationInventoryAck,
  verifyConfigurationInventoryAck,
} from '../../../farm-protocol/src/configuration-inventory.ts'
import {
  provisioningRequestFromEvidence,
  trustProvisioningAuthority,
  type InventoryAcknowledgementRequest,
  type ProvisioningContext,
  type TrustedProvisioningAuthority,
} from '../provisioning/authority.ts'
import type { ConfigurationIssuerSource } from './configuration-issuer.ts'

export interface ConfigurationAuthorityOptions {
  farm_id: string
  agent_id: string
  clock?: () => number
  /** Live authenticated signalling to the farm server. Outage refuses writes. */
  serverOnline: () => boolean
  /** JTI of the current, unexpired local credential, or null. */
  credentialJti: () => string | null
  /**
   * Trusted issuer source (HTTPS metadata of the enrolled farm origin). It is
   * the only way an inventory acknowledgement can be verified: there is no
   * injectable or boolean verifier.
   */
  issuers: ConfigurationIssuerSource
}

interface Transport {
  account_id: string
  key_id: string
  credential_jti: string
  browser_thumbprint: string
  connector_fingerprint: string
  binding_sha256: string
  origin: string
  audience: string
  expires_at: number
  open: boolean
}
interface Admitted {
  transport_id: string
  admission_nonce: string
  expires_at: number
  role: 'owner' | 'admin'
  action: ProvisioningContext['action']
  operation_id: string
  /** Issuer identity of the verified capability (never taken from an ack). */
  kid: string
  issuer: string
}
const INVENTORY_ACTIONS: readonly ProvisioningContext['action'][] = [
  'commit',
  'status',
]
const MAX_TRANSPORTS = 8
const MAX_ADMITTED = 64

/**
 * Connector-side current-authority view for config-v1. A context is current
 * only while: the server link is live, the local credential is the one the
 * capability names, the authenticated RTC transport that carried the
 * capability is still open and unexpired, and that exact capability (issuer
 * verified) is unexpired. Journal entries, receipts or caller flags never
 * substitute for it.
 */
export function createConfigurationAuthority(
  options: ConfigurationAuthorityOptions,
) {
  const clock = options.clock ?? Date.now
  const transports = new Map<string, Transport>()
  const admitted = new Map<string, Admitted>()

  function transportCurrent(id: string, now: number): Transport | null {
    const transport = transports.get(id)
    if (!transport?.open || now >= transport.expires_at) return null
    return transport
  }

  async function isCurrent(context: ProvisioningContext): Promise<boolean> {
    const now = clock()
    if (!options.serverOnline()) return false
    if (options.credentialJti() !== context.credential_jti) return false
    if (
      context.farm_id !== options.farm_id ||
      context.agent_id !== options.agent_id
    )
      return false
    const transport = transportCurrent(context.transport_id, now)
    const capability = admitted.get(context.capability_id)
    return (
      transport !== null &&
      transport.account_id === context.account_id &&
      transport.key_id === context.key_id &&
      transport.credential_jti === context.credential_jti &&
      capability !== undefined &&
      capability.transport_id === context.transport_id &&
      capability.admission_nonce === context.admission_nonce &&
      now < capability.expires_at
    )
  }

  /**
   * Authenticates one server inventory acknowledgement. The issuer, kid and
   * every context field come from trusted current state: the pinned HTTPS
   * issuer key for the kid of the verified capability this transport admitted,
   * the authenticated session binding and the canonical local identity. The
   * acknowledgement is verified, not trusted, and grants no command authority.
   */
  async function acceptsInventoryAck(
    request: InventoryAcknowledgementRequest,
  ): Promise<boolean> {
    try {
      const { ack, context } = request
      if (!(await isCurrent(context))) return false
      const now = clock()
      const transport = transportCurrent(context.transport_id, now)
      const capability = admitted.get(context.capability_id)
      if (
        !transport ||
        !capability ||
        capability.operation_id !== ack.operation_id ||
        !INVENTORY_ACTIONS.includes(capability.action)
      )
        return false
      const issuer = await options.issuers.forKid(capability.kid)
      if (
        !issuer ||
        issuer.origin !== transport.origin ||
        issuer.audience !== transport.audience ||
        !options.serverOnline()
      )
        return false
      return await verifyConfigurationInventoryAck(
        decodeConfigurationInventoryAck(request.attestation),
        issuer.key,
        {
          context: {
            account_id: context.account_id,
            farm_id: context.farm_id,
            agent_id: context.agent_id,
            key_id: context.key_id,
            transport_id: context.transport_id,
            browser_thumbprint: transport.browser_thumbprint,
            connector_fingerprint: transport.connector_fingerprint,
            credential_jti: context.credential_jti,
            configuration_binding_sha256: transport.binding_sha256,
            origin: transport.origin,
            audience: transport.audience,
          },
          kid: capability.kid,
          issuer: capability.issuer,
          operation_id: ack.operation_id,
          committed_receipt_sha256: ack.local_committed_receipt_sha256,
          committed_revision: ack.committed_revision,
          assignment_id: request.expected.assignment_id,
          printer_key: request.expected.printer_key,
        },
        now,
      )
    } catch {
      return false
    }
  }

  const adapter: TrustedProvisioningAuthority = trustProvisioningAuthority({
    isCurrent,
    acceptsInventoryAck,
  })

  return Object.freeze({
    adapter,
    /** Registers an RTC transport after mutual proofs and DTLS pins verified. */
    openTransport(
      binding: ConfigurationSessionBinding,
      bindingSha256: string,
    ): () => void {
      if (
        binding.farm_id !== options.farm_id ||
        binding.agent_id !== options.agent_id ||
        transports.has(binding.transport_id)
      )
        throw new Error('Configuration transport rejected')
      for (const [id, transport] of transports)
        if (!transport.open || clock() >= transport.expires_at)
          transports.delete(id)
      if (transports.size >= MAX_TRANSPORTS)
        throw new Error('Configuration transport limit')
      transports.set(binding.transport_id, {
        account_id: binding.account_id,
        key_id: binding.key_id,
        credential_jti: binding.credential_jti,
        browser_thumbprint: binding.browser_thumbprint,
        connector_fingerprint: binding.connector_fingerprint,
        binding_sha256: bindingSha256,
        origin: binding.origin,
        audience: binding.audience,
        expires_at: binding.expires_at,
        open: true,
      })
      return () => {
        const transport = transports.get(binding.transport_id)
        if (transport) transport.open = false
        for (const [id, capability] of admitted)
          if (capability.transport_id === binding.transport_id)
            admitted.delete(id)
      }
    },
    /**
     * Converts issuer-verified evidence into an engine request bound to the
     * open transport. Each capability is admitted at most once per process;
     * the engine ledger enforces exactly-once durably.
     */
    admit(
      evidence: ConfigurationAuthorityEvidence,
      transportId: string,
    ): {
      frame: ConfigurationRequestFrame
      context: ProvisioningContext
    } | null {
      if (!evidence.ok) return null
      const claims = evidence.claims
      const now = clock()
      const transport = transportCurrent(transportId, now)
      if (
        !transport ||
        claims.transport_id !== transportId ||
        claims.account_id !== transport.account_id ||
        claims.key_id !== transport.key_id ||
        claims.credential_jti !== transport.credential_jti ||
        claims.credential_jti !== options.credentialJti() ||
        claims.farm_id !== options.farm_id ||
        claims.agent_id !== options.agent_id ||
        (claims.role !== 'owner' && claims.role !== 'admin') ||
        admitted.has(claims.capability_id) ||
        now >= claims.expires_at
      )
        return null
      const request = provisioningRequestFromEvidence(evidence)
      if (!request) return null
      if (admitted.size >= MAX_ADMITTED) {
        for (const [id, capability] of admitted)
          if (now >= capability.expires_at) admitted.delete(id)
        if (admitted.size >= MAX_ADMITTED) return null
      }
      admitted.set(claims.capability_id, {
        transport_id: transportId,
        admission_nonce: claims.admission_nonce,
        expires_at: Math.min(claims.expires_at, transport.expires_at),
        role: claims.role,
        action: claims.action,
        operation_id: claims.operation_id,
        kid: claims.kid,
        issuer: claims.issuer,
      })
      return request
    },
    /**
     * Context for an inventory confirmation on this transport: only an
     * unexpired capability this transport already admitted (owner/admin,
     * issuer-verified, commit or status of the same operation) qualifies. A
     * signed acknowledgement alone never creates authority; without such a
     * fresh admission the caller must request a new status capability.
     */
    inventoryContext(
      transportId: string,
      operationId: string,
    ): ProvisioningContext | null {
      const now = clock()
      const transport = transportCurrent(transportId, now)
      if (!transport) return null
      let best: [string, Admitted] | null = null
      for (const entry of admitted) {
        const [, capability] = entry
        if (
          capability.transport_id === transportId &&
          capability.operation_id === operationId &&
          INVENTORY_ACTIONS.includes(capability.action) &&
          now < capability.expires_at &&
          (best === null || capability.expires_at > best[1].expires_at)
        )
          best = entry
      }
      if (!best) return null
      const [capabilityId, capability] = best
      return {
        account_id: transport.account_id,
        role: capability.role,
        farm_id: options.farm_id,
        agent_id: options.agent_id,
        key_id: transport.key_id,
        credential_jti: transport.credential_jti,
        transport_id: transportId,
        connector_fingerprint: transport.connector_fingerprint,
        capability_id: capabilityId,
        admission_nonce: capability.admission_nonce,
        action: capability.action,
      }
    },
    /** Server outage, credential change or shutdown: nothing stays current. */
    revokeAll(): void {
      for (const transport of transports.values()) transport.open = false
      admitted.clear()
    },
    diagnostics() {
      return Object.freeze({
        openTransports: [...transports.values()].filter((t) => t.open).length,
        admittedCapabilities: admitted.size,
      })
    },
  })
}
export type ConfigurationAuthority = ReturnType<
  typeof createConfigurationAuthority
>
