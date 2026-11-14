import { z } from 'zod'
import { canonicalize } from './canonical.ts'
import { base64url, decodeBase64url } from './encoding.ts'
import {
  BrowserDeviceTextId,
  BrowserDeviceUuid,
} from './browser-device-proof.ts'
import { ConfigurationCapabilityV1 } from './configuration-capability.ts'
import {
  CONFIGURATION_HARD_MAXIMUMS,
  configurationCodec,
  configurationDigest,
  configurationFresh,
  configurationHash,
  configurationLifetime,
  configurationOpaqueId,
  configurationPayload,
  configurationSignature,
  configurationTime,
  requireEd25519Private,
} from './configuration-common.ts'

const identityDomain =
  'Open3DFarmManager/configuration-assignment-identity/config-v1\0'
const ackDomain = 'Open3DFarmManager/configuration-inventory-ack/config-v1\0'

export const ConfigurationStableAssignment = z.strictObject({
  account_id: BrowserDeviceTextId,
  farm_id: BrowserDeviceUuid,
  agent_id: BrowserDeviceUuid,
  bridge_instance_id: configurationOpaqueId,
  device_id: configurationOpaqueId,
})
export type ConfigurationStableAssignment = z.infer<
  typeof ConfigurationStableAssignment
>

/** Identity is not authority. Callers must reject existing conflicting bindings. */
export async function deriveConfigurationAssignmentIdentity(input: unknown) {
  const stable = ConfigurationStableAssignment.parse(input)
  const digest = await configurationHash(identityDomain, canonicalize(stable))
  const bytes = decodeBase64url(digest, 32)
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
  const variant = ((bytes[8] ?? 0) & 63) | 128
  const assignment_id = BrowserDeviceUuid.parse(
    hex.slice(0, 8) +
      '-' +
      hex.slice(8, 12) +
      '-8' +
      hex.slice(13, 16) +
      '-' +
      variant.toString(16) +
      hex.slice(18, 20) +
      '-' +
      hex.slice(20, 32),
  )
  return { assignment_id, printer_key: 'kobra-x-' + digest }
}

export const ConfigurationInventoryContext = z
  .strictObject(ConfigurationCapabilityV1.shape)
  .pick({
    account_id: true,
    farm_id: true,
    agent_id: true,
    key_id: true,
    transport_id: true,
    browser_thumbprint: true,
    connector_fingerprint: true,
    credential_jti: true,
    configuration_binding_sha256: true,
    origin: true,
    audience: true,
  })
export type ConfigurationInventoryContext = z.infer<
  typeof ConfigurationInventoryContext
>

const fields = {
  v: z.literal(1),
  protocol: z.literal('config-v1'),
  purpose: z.literal('configuration-inventory-ack'),
  context: ConfigurationInventoryContext,
  kid: ConfigurationCapabilityV1.shape.kid,
  issuer: ConfigurationCapabilityV1.shape.issuer,
  operation_id: BrowserDeviceUuid,
  committed_receipt_sha256: configurationDigest,
  committed_revision: z.number().int().min(1).max(2_147_483_646),
  assignment_id: BrowserDeviceUuid,
  printer_key: z
    .string()
    .regex(/^kobra-x-[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/),
  nonce: configurationDigest,
  issued_at: configurationTime,
  expires_at: configurationTime,
}
const lifetime = (value: { issued_at: number; expires_at: number }) =>
  configurationLifetime(value, 30_000)
export const ConfigurationInventoryAck = z.strictObject(fields).refine(lifetime)
export type ConfigurationInventoryAck = z.infer<
  typeof ConfigurationInventoryAck
>
export const SignedConfigurationInventoryAck = z
  .strictObject({
    ...fields,
    signature: configurationSignature,
  })
  .refine(lifetime)
export type SignedConfigurationInventoryAck = z.infer<
  typeof SignedConfigurationInventoryAck
>
const codec = configurationCodec(
  SignedConfigurationInventoryAck,
  'configuration inventory ack',
  {
    maxBytes: 8192,
    maxDepth: 3,
    maxValues: 64,
    maxStringChars: 256,
  },
)
export const encodeConfigurationInventoryAck = codec.encode
export const decodeConfigurationInventoryAck = codec.decode

export function configurationInventoryAckPayload(input: unknown) {
  return configurationPayload(
    ackDomain,
    canonicalize(ConfigurationInventoryAck.parse(input)),
  )
}

/** Server must validate fresh authority and persist inventory before signing. */
export async function signConfigurationInventoryAck(
  input: unknown,
  key: CryptoKey,
) {
  requireEd25519Private(key, 'configuration inventory issuer')
  const claims = ConfigurationInventoryAck.parse(input)
  const signature = base64url(
    new Uint8Array(
      await crypto.subtle.sign(
        'Ed25519',
        key,
        configurationInventoryAckPayload(claims),
      ),
    ),
  )
  return decodeConfigurationInventoryAck(
    encodeConfigurationInventoryAck({ ...claims, signature }),
  )
}

export const ConfigurationInventoryExpectation = z
  .strictObject(ConfigurationInventoryAck.shape)
  .omit({
    v: true,
    protocol: true,
    purpose: true,
    nonce: true,
    issued_at: true,
    expires_at: true,
  })
export type ConfigurationInventoryExpectation = z.infer<
  typeof ConfigurationInventoryExpectation
>

/** Cryptographic acknowledgement only. Fresh current configuration authority is
 * still required before local mutation. An ack loss never authorizes creation again.
 * The expected context and issuer key must come from trusted current caller state.
 */
export async function verifyConfigurationInventoryAck(
  input: unknown,
  issuerKey: CryptoKey,
  expected: ConfigurationInventoryExpectation,
  now: number,
): Promise<boolean> {
  try {
    if (issuerKey.type !== 'public' || issuerKey.algorithm.name !== 'Ed25519')
      return false
    const ack = decodeConfigurationInventoryAck(
      encodeConfigurationInventoryAck(input),
    )
    const expectation = ConfigurationInventoryExpectation.parse(expected)
    const {
      signature,
      v: _v,
      protocol: _protocol,
      purpose: _purpose,
      nonce: _nonce,
      issued_at: _issued,
      expires_at: _expires,
      ...actual
    } = ack
    if (
      !configurationFresh(ack, now, CONFIGURATION_HARD_MAXIMUMS.skewMs) ||
      canonicalize(actual) !== canonicalize(expectation)
    )
      return false
    const { signature: _signature, ...claims } = ack
    return await crypto.subtle.verify(
      'Ed25519',
      issuerKey,
      new Uint8Array(decodeBase64url(signature, 64)),
      configurationInventoryAckPayload(claims),
    )
  } catch {
    return false
  }
}
