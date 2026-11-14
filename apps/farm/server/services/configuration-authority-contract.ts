import { z } from 'zod'
import { canonicalize } from '../../../../packages/farm-protocol/src/canonical.ts'
import {
  BrowserDevicePublicKey,
  BrowserDeviceTextId,
  BrowserDeviceUuid,
} from '../../../../packages/farm-protocol/src/browser-device-proof.ts'
import { PairingPublicKey } from '../../../../packages/farm-protocol/src/pairing.ts'
import {
  PairingProofAudience,
  PairingProofOrigin,
} from '../../../../packages/farm-protocol/src/pairing-proof.ts'
import {
  ConfigurationRole,
  configurationDigest,
  configurationFingerprint,
  configurationOpaqueId,
  configurationTime,
} from '../../../../packages/farm-protocol/src/configuration-common.ts'
import { ConfigurationAdmissionChallenge } from '../../../../packages/farm-protocol/src/configuration-capability.ts'
import type { ConfigurationSessionBinding } from '../../../../packages/farm-protocol/src/configuration-binding.ts'

/**
 * Storage and registry contracts of the config-v1 server authority.
 *
 * Configuration authority is separate from pause/read-only authority: it needs
 * no printer assignment (a freshly enrolled Connector has none), and it is
 * limited to owner/admin. Nothing here is a grant by itself.
 */
export const ConfigurationScope = z.strictObject({
  sessionRecordId: BrowserDeviceTextId,
  farmId: BrowserDeviceUuid,
  agentId: BrowserDeviceUuid,
  keyId: BrowserDeviceUuid,
})
export type ConfigurationScope = z.infer<typeof ConfigurationScope>

const revision = z.number().int().nonnegative().max(2_147_483_646)

/** Current, locked authority. `validUntil` is the earliest session/credential expiry. */
export const ConfigurationAuthority = z.strictObject({
  account_id: BrowserDeviceTextId,
  role: ConfigurationRole,
  farm_id: BrowserDeviceUuid,
  agent_id: BrowserDeviceUuid,
  key_id: BrowserDeviceUuid,
  browser_public_key: BrowserDevicePublicKey,
  browser_thumbprint: configurationDigest,
  connector_public_key_spki: PairingPublicKey,
  connector_fingerprint: configurationFingerprint,
  credential_jti: BrowserDeviceUuid,
  origin: PairingProofOrigin,
  audience: PairingProofAudience,
  validUntil: configurationTime,
})
export type ConfigurationAuthority = z.infer<typeof ConfigurationAuthority>

export const ConfigurationOperationRecord = z.strictObject({
  operation_id: BrowserDeviceUuid,
  account_id: BrowserDeviceTextId,
  farm_id: BrowserDeviceUuid,
  agent_id: BrowserDeviceUuid,
  key_id: BrowserDeviceUuid,
  expected_revision: revision,
  /** Hash of the exact prepare target. Immutable for the operation. */
  target_sha256: configurationDigest,
  /** Hash of the prepared receipt pinned by the first commit admission. */
  commit_sha256: configurationDigest.nullable(),
  created_at: configurationTime,
})
export type ConfigurationOperationRecord = z.infer<
  typeof ConfigurationOperationRecord
>

export const ConfigurationChallengeRecord = z.strictObject({
  challenge: ConfigurationAdmissionChallenge,
  /** Canonical authority pins observed at issuance (never contains secrets). */
  pins: z.string().min(1).max(4096),
})
export type ConfigurationChallengeRecord = z.infer<
  typeof ConfigurationChallengeRecord
>

export const ConfigurationReceiptRecord = z.strictObject({
  operation_id: BrowserDeviceUuid,
  receipt_sha256: configurationDigest,
  assignment_id: BrowserDeviceUuid,
})
export type ConfigurationReceiptRecord = z.infer<
  typeof ConfigurationReceiptRecord
>

export const ConfigurationReceiptRegistration = z.strictObject({
  operation_id: BrowserDeviceUuid,
  receipt_sha256: configurationDigest,
  /** Canonical signed receipt. Holds no cookie, password, key or address. */
  receipt_wire: z.string().min(1).max(8192),
  farm_id: BrowserDeviceUuid,
  agent_id: BrowserDeviceUuid,
  account_id: BrowserDeviceTextId,
  bridge_instance_id: configurationOpaqueId,
  device_id: configurationOpaqueId,
  assignment_id: BrowserDeviceUuid,
  printer_key: z
    .string()
    .regex(/^kobra-x-[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/),
  committed_revision: revision,
  registered_at: configurationTime,
})
export type ConfigurationReceiptRegistration = z.infer<
  typeof ConfigurationReceiptRegistration
>

/**
 * One serializable transaction. Implementations lock the session, account,
 * membership, browser device key, Connector enrollment and current credential
 * for the whole callback, and commit when it resolves (a denial is a normal
 * committed result, so a consumed challenge stays consumed). A rejection rolls
 * everything back.
 */
export interface ConfigurationAuthorityTransaction {
  /** Null for every denial: revoked, expired, other account/farm, not owner/admin, stale credential. */
  readonly authority: ConfigurationAuthority | null
  /** Storage-observed wall time in milliseconds. */
  readonly observedAt: number
  operation(operationId: string): Promise<ConfigurationOperationRecord | null>
  /** False when the operation ID already exists. */
  createOperation(record: ConfigurationOperationRecord): Promise<boolean>
  /** Sets commit_sha256 once. False when it is already set. */
  pinCommit(operationId: string, commitSha256: string): Promise<boolean>
  /** False on a reused challenge ID, capability ID or admission nonce. */
  insertChallenge(record: ConfigurationChallengeRecord): Promise<boolean>
  /** Exactly-once: returns the record and makes every later call return null. */
  consumeChallenge(
    challengeId: string,
  ): Promise<ConfigurationChallengeRecord | null>
  receipt(operationId: string): Promise<ConfigurationReceiptRecord | null>
  /**
   * Atomically stores the receipt and creates the active assignment for
   * `printer_key`. `conflict` when the key is actively assigned already or the
   * operation has another receipt.
   */
  registerReceipt(
    record: ConfigurationReceiptRegistration,
  ): Promise<{ ok: true; assignmentId: string } | { ok: false }>
}
export interface ConfigurationAuthorityStore {
  transaction<T>(
    scope: ConfigurationScope,
    work: (tx: ConfigurationAuthorityTransaction) => Promise<T>,
  ): Promise<T>
}

/** Live in-process signalling facts. Presence is advisory and grants nothing alone. */
export interface ConfigurationLiveRegistry {
  /** A binding this server issued for a still-open, unexpired transport. */
  bound(
    bindingSha256: string,
  ): Readonly<{ transportId: string; expiresAt: number }> | null
  /** The authenticated Connector currently advertising config-v1 for the agent. */
  advertised(
    farmId: string,
    agentId: string,
  ): Readonly<{ jti: string; revision: number }> | null
  /** The open, unexpired bound RTC context for the caller's current authority. */
  activeContext(scope: {
    sessionRecordId: string
    farmId: string
    agentId: string
    keyId: string
    accountId: string
    credentialJti: string
  }): Readonly<{
    transportId: string
    bindingSha256: string
    expiresAt: number
  }> | null
}

export type ConfigurationFailureReason =
  'invalid-input' | 'denied' | 'conflict' | 'capacity' | 'storage-unavailable'
export type ConfigurationFailure = {
  ok: false
  reason: ConfigurationFailureReason
}
export const configurationFailure = (
  reason: ConfigurationFailureReason,
): ConfigurationFailure => ({ ok: false, reason })

/** Everything except the moving expiry. Any difference means another authority. */
export function configurationAuthorityPins(
  authority: ConfigurationAuthority,
): string {
  const { validUntil: _validUntil, ...pins } = authority
  return canonicalize(pins)
}

export function configurationAuthorityMatchesBinding(
  authority: ConfigurationAuthority,
  binding: ConfigurationSessionBinding,
): boolean {
  return (
    authority.account_id === binding.account_id &&
    authority.farm_id === binding.farm_id &&
    authority.agent_id === binding.agent_id &&
    authority.key_id === binding.key_id &&
    authority.browser_thumbprint === binding.browser_thumbprint &&
    canonicalize(authority.browser_public_key) ===
      canonicalize(binding.browser_public_key) &&
    authority.connector_public_key_spki === binding.connector_public_key_spki &&
    authority.connector_fingerprint === binding.connector_fingerprint &&
    authority.credential_jti === binding.credential_jti &&
    authority.origin === binding.origin &&
    authority.audience === binding.audience
  )
}

/** Parses a store-provided authority; a malformed or non owner/admin row is a denial. */
export function currentConfigurationAuthority(
  tx: ConfigurationAuthorityTransaction,
  scope: Pick<ConfigurationScope, 'farmId' | 'agentId' | 'keyId'>,
): ConfigurationAuthority | null {
  const parsed = ConfigurationAuthority.safeParse(tx.authority)
  if (
    !parsed.success ||
    !Number.isSafeInteger(tx.observedAt) ||
    tx.observedAt < 0 ||
    parsed.data.farm_id !== scope.farmId ||
    parsed.data.agent_id !== scope.agentId ||
    parsed.data.key_id !== scope.keyId ||
    tx.observedAt >= parsed.data.validUntil
  )
    return null
  return parsed.data
}
