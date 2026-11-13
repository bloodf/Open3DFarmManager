import { z } from 'zod'
import { canonicalize } from './canonical.ts'
import { base64url, decodeBase64url } from './encoding.ts'
import {
  BrowserDeviceUuid,
  BrowserDeviceTextId,
} from './browser-device-proof.ts'
import { connectorFingerprintFromSpki } from './configuration-binding.ts'
import {
  CONFIGURATION_DOMAINS,
  CONFIGURATION_PROTOCOL,
  MAX_CONFIGURATION_PROOF_WIRE_BYTES,
  configurationCodec,
  configurationDigest,
  configurationFingerprint,
  configurationHash,
  configurationPayload,
  configurationSignature,
  configurationTime,
  requireEd25519Private,
} from './configuration-common.ts'
import {
  ConfigurationImmutableTarget,
  ConfigurationObservedDevice,
} from './configuration-target.ts'

/**
 * Honest result states. `unknown` is never signed: it means no durable
 * evidence is available. `prepared` never claims a connection or a commit.
 */
export const CONFIGURATION_RESULT_STATES = [
  'prepared',
  'local-committed',
  'inventory-confirmed',
  'recovery-required',
  'unknown',
] as const
export const ConfigurationResultState = z.enum(CONFIGURATION_RESULT_STATES)
export type ConfigurationResultState = z.infer<typeof ConfigurationResultState>
export const ConfigurationReceiptPhase = z.enum([
  'prepared',
  'local-committed',
  'inventory-confirmed',
  'recovery-required',
])
export type ConfigurationReceiptPhase = z.infer<
  typeof ConfigurationReceiptPhase
>
export const ConfigurationRecoveryReason = z.enum([
  'commit-incomplete',
  'rollback-failed',
  'inventory-mismatch',
  'journal-inconsistent',
])

const revision = z.number().int().nonnegative().max(2_147_483_646)
export const ConfigurationReceiptClaims = z
  .strictObject({
    v: z.literal(1),
    purpose: z.literal('configuration-receipt'),
    protocol: z.literal(CONFIGURATION_PROTOCOL),
    receipt_id: BrowserDeviceUuid,
    account_id: BrowserDeviceTextId,
    farm_id: BrowserDeviceUuid,
    agent_id: BrowserDeviceUuid,
    connector_fingerprint: configurationFingerprint,
    operation_id: BrowserDeviceUuid,
    phase: ConfigurationReceiptPhase,
    target: ConfigurationImmutableTarget,
    observed: ConfigurationObservedDevice,
    expected_revision: revision,
    committed_revision: revision.nullable(),
    recovery_reason: ConfigurationRecoveryReason.nullable(),
    prior_receipt_sha256: configurationDigest.nullable(),
    issued_at: configurationTime,
  })
  .refine((value) => {
    const committed =
      value.phase === 'local-committed' || value.phase === 'inventory-confirmed'
    return (
      value.observed.device_id === value.target.device_id &&
      (committed
        ? value.committed_revision === value.expected_revision + 1
        : value.committed_revision === null) &&
      (value.phase === 'recovery-required') ===
        (value.recovery_reason !== null) &&
      (value.phase === 'prepared') === (value.prior_receipt_sha256 === null)
    )
  }, 'Inconsistent configuration receipt')
export type ConfigurationReceiptClaims = z.infer<
  typeof ConfigurationReceiptClaims
>
export const SignedConfigurationReceipt = z
  .strictObject({
    ...ConfigurationReceiptClaims.shape,
    signature: configurationSignature,
  })
  .refine((value) => {
    const { signature: _signature, ...claims } = value
    return ConfigurationReceiptClaims.safeParse(claims).success
  })
export type SignedConfigurationReceipt = z.infer<
  typeof SignedConfigurationReceipt
>

const receiptCodec = configurationCodec(
  SignedConfigurationReceipt,
  'configuration receipt',
  {
    maxBytes: MAX_CONFIGURATION_PROOF_WIRE_BYTES,
    maxDepth: 5,
    maxValues: 80,
    maxStringChars: 256,
  },
)
export const encodeConfigurationReceipt = receiptCodec.encode
export const decodeConfigurationReceipt = receiptCodec.decode

export function configurationReceiptPayload(
  input: unknown,
): Uint8Array<ArrayBuffer> {
  return configurationPayload(
    CONFIGURATION_DOMAINS.receipt,
    canonicalize(ConfigurationReceiptClaims.parse(input)),
  )
}

/** Hash of the full signed receipt, used to chain receipts and bind `commit`. */
export async function configurationReceiptHash(
  input: unknown,
): Promise<string> {
  const receipt = SignedConfigurationReceipt.parse(input)
  return configurationHash(
    CONFIGURATION_DOMAINS.receiptHash,
    canonicalize(receipt),
  )
}

/** Connector-only primitive. Signing is not proof the journal entry is durable; the caller must persist first. */
export async function signConfigurationReceipt(
  input: unknown,
  key: CryptoKey,
): Promise<SignedConfigurationReceipt> {
  requireEd25519Private(key, 'Connector receipt')
  const claims = ConfigurationReceiptClaims.parse(input)
  const signature = base64url(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: 'Ed25519' },
        key,
        configurationReceiptPayload(claims),
      ),
    ),
  )
  const signed = SignedConfigurationReceipt.parse({ ...claims, signature })
  encodeConfigurationReceipt(signed)
  return signed
}

/**
 * Explicit trusted Connector key only. Signature validity proves the holder of
 * that key issued the claims; it does not prove the operation is still current.
 */
export async function verifyConfigurationReceipt(
  input: unknown,
  connectorPublicKey: CryptoKey,
): Promise<boolean> {
  try {
    if (
      connectorPublicKey.type !== 'public' ||
      connectorPublicKey.algorithm.name !== 'Ed25519'
    )
      return false
    const receipt = SignedConfigurationReceipt.parse(input)
    encodeConfigurationReceipt(receipt)
    const spki = base64url(
      new Uint8Array(await crypto.subtle.exportKey('spki', connectorPublicKey)),
    )
    if (
      (await connectorFingerprintFromSpki(spki)) !==
      receipt.connector_fingerprint
    )
      return false
    const { signature, ...claims } = receipt
    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      connectorPublicKey,
      new Uint8Array(decodeBase64url(signature, 64)),
      configurationReceiptPayload(claims),
    )
  } catch {
    return false
  }
}

export interface ConfigurationReceiptContext {
  account_id: string
  farm_id: string
  agent_id: string
  operation_id: string
  target_sha256: string
  device_id: string
  expected_revision: number
}

/** Pure context equality. Run after `verifyConfigurationReceipt`; never replaces live checks. */
export function configurationReceiptMatchesContext(
  receipt: SignedConfigurationReceipt,
  context: ConfigurationReceiptContext,
): boolean {
  return (
    receipt.account_id === context.account_id &&
    receipt.farm_id === context.farm_id &&
    receipt.agent_id === context.agent_id &&
    receipt.operation_id === context.operation_id &&
    receipt.target.target_sha256 === context.target_sha256 &&
    receipt.target.device_id === context.device_id &&
    receipt.expected_revision === context.expected_revision
  )
}
