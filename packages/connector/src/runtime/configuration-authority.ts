import type { ConfigurationSessionBinding } from '../../../farm-protocol/src/configuration-binding.ts'
import type { ConfigurationAuthorityEvidence } from '../../../farm-protocol/src/configuration-capability.ts'
import type { ConfigurationRequestFrame } from '../../../farm-protocol/src/configuration-frames.ts'
import {
  provisioningRequestFromEvidence,
  trustProvisioningAuthority,
  type InventoryAcknowledgement,
  type ProvisioningContext,
  type TrustedProvisioningAuthority,
} from '../provisioning/authority.ts'

/**
 * Verifies a server-issued inventory confirmation for one committed receipt.
 * The accepted server contract has no such signed artifact yet, so production
 * installs none and inventory acknowledgements fail closed.
 */
export type InventoryAttestationVerifier = (input: {
  ack: InventoryAcknowledgement
  attestation: string
  farm_id: string
  agent_id: string
}) => Promise<boolean>

export interface ConfigurationAuthorityOptions {
  farm_id: string
  agent_id: string
  clock?: () => number
  /** Live authenticated signalling to the farm server. Outage refuses writes. */
  serverOnline: () => boolean
  /** JTI of the current, unexpired local credential, or null. */
  credentialJti: () => string | null
  inventoryVerifier?: InventoryAttestationVerifier
}

interface Transport {
  account_id: string
  key_id: string
  credential_jti: string
  expires_at: number
  open: boolean
}
interface Admitted {
  transport_id: string
  admission_nonce: string
  expires_at: number
}
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
  const attestations = new Map<string, string>()

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

  async function acceptsInventoryAck(
    ack: InventoryAcknowledgement,
  ): Promise<boolean> {
    const attestation = attestations.get(ack.operation_id)
    if (!options.inventoryVerifier || attestation === undefined) return false
    if (!options.serverOnline()) return false
    return (
      (await options.inventoryVerifier({
        ack: { ...ack },
        attestation,
        farm_id: options.farm_id,
        agent_id: options.agent_id,
      })) === true
    )
  }

  const adapter: TrustedProvisioningAuthority = trustProvisioningAuthority({
    isCurrent,
    acceptsInventoryAck,
  })

  return Object.freeze({
    adapter,
    /** Registers an RTC transport after mutual proofs and DTLS pins verified. */
    openTransport(binding: ConfigurationSessionBinding): () => void {
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
      })
      return request
    },
    /** Supplies one attestation for the duration of a confirmation attempt. */
    async withAttestation<T>(
      operationId: string,
      attestation: string,
      run: () => Promise<T>,
    ): Promise<T> {
      if (attestations.has(operationId)) throw new Error('Confirmation busy')
      attestations.set(operationId, attestation)
      try {
        return await run()
      } finally {
        attestations.delete(operationId)
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
        inventoryVerifier: options.inventoryVerifier !== undefined,
      })
    },
  })
}
export type ConfigurationAuthority = ReturnType<
  typeof createConfigurationAuthority
>
