import { z } from 'zod'
import {
  BrowserDeviceTextId,
  BrowserDeviceUuid,
} from '../../../farm-protocol/src/browser-device-proof.ts'
import {
  ConfigurationAction,
  ConfigurationRole,
  configurationDigest,
  configurationFingerprint,
} from '../../../farm-protocol/src/configuration-common.ts'
import type { ConfigurationAuthorityEvidence } from '../../../farm-protocol/src/configuration-capability.ts'
import { ConfigurationRequestFrame } from '../../../farm-protocol/src/configuration-frames.ts'

/**
 * Context an authenticated config-v1 session hands the engine. It is derived
 * from verified cryptographic evidence and is NOT current authority by itself:
 * the trusted adapter is consulted before every action and mutation.
 */
export const ProvisioningContext = z.strictObject({
  account_id: BrowserDeviceTextId,
  role: ConfigurationRole,
  farm_id: BrowserDeviceUuid,
  agent_id: BrowserDeviceUuid,
  key_id: BrowserDeviceUuid,
  credential_jti: BrowserDeviceUuid,
  transport_id: BrowserDeviceUuid,
  connector_fingerprint: configurationFingerprint,
  capability_id: BrowserDeviceUuid,
  admission_nonce: configurationDigest,
  action: ConfigurationAction,
})
export type ProvisioningContext = z.infer<typeof ProvisioningContext>

export interface InventoryAcknowledgement {
  operation_id: string
  local_committed_receipt_sha256: string
  committed_revision: number
}

/**
 * Narrow adapter supplied by the Connector integration. `isCurrent` must
 * check live role (owner/admin), revocation of account, key, credential and
 * RTC session. `acceptsInventoryAck` must authenticate the server-side
 * inventory confirmation. Neither is implemented here: production wiring is
 * the next unit and this module makes no claim about a deployed authority.
 */
export interface ProvisioningAuthorityAdapter {
  isCurrent(context: ProvisioningContext): Promise<boolean>
  acceptsInventoryAck(ack: InventoryAcknowledgement): Promise<boolean>
}

const trusted = new WeakSet<object>()
export type TrustedProvisioningAuthority =
  Readonly<ProvisioningAuthorityAdapter>

/** Explicit opt-in: only adapters passed through here are accepted. */
export function trustProvisioningAuthority(
  adapter: ProvisioningAuthorityAdapter,
): TrustedProvisioningAuthority {
  if (
    typeof adapter?.isCurrent !== 'function' ||
    typeof adapter.acceptsInventoryAck !== 'function'
  )
    throw new Error('Invalid provisioning authority adapter')
  const frozen = Object.freeze({
    isCurrent: adapter.isCurrent.bind(adapter),
    acceptsInventoryAck: adapter.acceptsInventoryAck.bind(adapter),
  })
  trusted.add(frozen)
  return frozen
}
export function isTrustedProvisioningAuthority(value: unknown): boolean {
  return typeof value === 'object' && value !== null && trusted.has(value)
}

/**
 * Integration entry point for the upcoming config-v1 session: converts
 * verified evidence into an engine request. It performs no authority check.
 */
export function provisioningRequestFromEvidence(
  evidence: ConfigurationAuthorityEvidence,
): { frame: ConfigurationRequestFrame; context: ProvisioningContext } | null {
  if (!evidence.ok || evidence.evidence !== 'cryptographic-only') return null
  const claims = evidence.claims
  const frame = ConfigurationRequestFrame.safeParse(evidence.frame)
  const context = ProvisioningContext.safeParse({
    account_id: claims.account_id,
    role: claims.role,
    farm_id: claims.farm_id,
    agent_id: claims.agent_id,
    key_id: claims.key_id,
    credential_jti: claims.credential_jti,
    transport_id: claims.transport_id,
    connector_fingerprint: claims.connector_fingerprint,
    capability_id: evidence.replayKey.capability_id,
    admission_nonce: evidence.replayKey.admission_nonce,
    action: claims.action,
  })
  if (
    !frame.success ||
    !context.success ||
    frame.data.type !== claims.action ||
    evidence.replayKey.operation_id !== frame.data.operation_id
  )
    return null
  return { frame: frame.data, context: context.data }
}
