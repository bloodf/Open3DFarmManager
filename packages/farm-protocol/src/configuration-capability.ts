import { z } from 'zod'
import { canonicalize } from './canonical.ts'
import { base64url, decodeBase64url } from './encoding.ts'
import {
  BrowserDeviceUuid,
  BrowserDeviceTextId,
  BrowserDevicePublicKey,
  validateBrowserDevicePublicKey,
} from './browser-device-proof.ts'
import { PairingProofOrigin, PairingProofAudience } from './pairing-proof.ts'
import {
  configurationBindingHash,
  validateConfigurationSessionBinding,
} from './configuration-binding.ts'
import {
  CONFIGURATION_DOMAINS,
  CONFIGURATION_HARD_MAXIMUMS,
  CONFIGURATION_PROTOCOL,
  MAX_CONFIGURATION_PROOF_WIRE_BYTES,
  ConfigurationAction,
  ConfigurationRole,
  configurationCodec,
  configurationDigest,
  configurationFingerprint,
  configurationFresh,
  configurationLifetime,
  configurationPayload,
  configurationSignature,
  configurationTime,
  requireEd25519Private,
  requireP256Private,
} from './configuration-common.ts'
import {
  ConfigurationRequestFrame,
  configurationFrameTargetHash,
} from './configuration-frames.ts'

const revision = z.number().int().nonnegative().max(2_147_483_646)
const capabilityFields = {
  v: z.literal(1),
  purpose: z.literal('configuration-authority'),
  protocol: z.literal(CONFIGURATION_PROTOCOL),
  capability_id: BrowserDeviceUuid,
  kid: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  issuer: PairingProofAudience,
  audience: PairingProofAudience,
  origin: PairingProofOrigin,
  issued_at: configurationTime,
  expires_at: configurationTime,
  account_id: BrowserDeviceTextId,
  role: ConfigurationRole,
  farm_id: BrowserDeviceUuid,
  agent_id: BrowserDeviceUuid,
  key_id: BrowserDeviceUuid,
  transport_id: BrowserDeviceUuid,
  browser_public_key: BrowserDevicePublicKey,
  browser_thumbprint: configurationDigest,
  connector_fingerprint: configurationFingerprint,
  credential_jti: BrowserDeviceUuid,
  configuration_binding_sha256: configurationDigest,
  admission_nonce: configurationDigest,
  action: ConfigurationAction,
  operation_id: BrowserDeviceUuid,
  expected_revision: revision,
  target_sha256: configurationDigest,
}
const lifetime = (value: { issued_at: number; expires_at: number }) =>
  configurationLifetime(value, CONFIGURATION_HARD_MAXIMUMS.capabilityMs)

export const ConfigurationCapabilityV1 = z
  .strictObject(capabilityFields)
  .refine(lifetime)
export type ConfigurationCapabilityV1 = z.infer<
  typeof ConfigurationCapabilityV1
>
export const SignedConfigurationCapabilityV1 = z
  .strictObject({ ...capabilityFields, signature: configurationSignature })
  .refine(lifetime)
export type SignedConfigurationCapabilityV1 = z.infer<
  typeof SignedConfigurationCapabilityV1
>

const capabilityCodec = configurationCodec(
  SignedConfigurationCapabilityV1,
  'configuration capability',
  {
    maxBytes: MAX_CONFIGURATION_PROOF_WIRE_BYTES,
    maxDepth: 4,
    maxValues: 100,
    maxStringChars: 256,
  },
)
export const encodeConfigurationCapability = capabilityCodec.encode
export const decodeConfigurationCapability = capabilityCodec.decode

export function configurationCapabilityPayload(
  input: unknown,
): Uint8Array<ArrayBuffer> {
  return configurationPayload(
    CONFIGURATION_DOMAINS.capability,
    canonicalize(ConfigurationCapabilityV1.parse(input)),
  )
}

async function validateCapability(
  input: unknown,
): Promise<ConfigurationCapabilityV1> {
  const parsed = ConfigurationCapabilityV1.parse(input)
  const key = await validateBrowserDevicePublicKey(parsed.browser_public_key)
  if (key.thumbprint !== parsed.browser_thumbprint)
    throw new Error('Configuration capability key mismatch')
  return parsed
}

/**
 * Trusted issuer key primitive only. Issuance requires current transactional
 * owner/admin authority on the server; this function cannot establish it.
 */
export async function signConfigurationCapability(
  input: unknown,
  key: CryptoKey,
): Promise<SignedConfigurationCapabilityV1> {
  requireEd25519Private(key, 'configuration issuer')
  const claims = await validateCapability(input)
  const signature = base64url(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: 'Ed25519' },
        key,
        configurationCapabilityPayload(claims),
      ),
    ),
  )
  const signed = SignedConfigurationCapabilityV1.parse({ ...claims, signature })
  encodeConfigurationCapability(signed)
  return signed
}

/** Explicit trusted key only: no embedded issuer key, algorithm choice or bearer authentication. */
export async function verifyConfigurationCapability(
  input: unknown,
  key: CryptoKey,
): Promise<boolean> {
  try {
    if (key.type !== 'public' || key.algorithm.name !== 'Ed25519') return false
    const parsed = SignedConfigurationCapabilityV1.parse(input)
    const { signature, ...unsigned } = parsed
    encodeConfigurationCapability(parsed)
    const claims = await validateCapability(unsigned)
    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      new Uint8Array(decodeBase64url(signature, 64)),
      configurationCapabilityPayload(claims),
    )
  } catch {
    return false
  }
}

export const ConfigurationAdmissionChallenge = z
  .strictObject({
    v: z.literal(1),
    purpose: z.literal('configuration-admission'),
    protocol: z.literal(CONFIGURATION_PROTOCOL),
    challenge_id: BrowserDeviceUuid,
    capability_id: BrowserDeviceUuid,
    farm_id: BrowserDeviceUuid,
    agent_id: BrowserDeviceUuid,
    key_id: BrowserDeviceUuid,
    transport_id: BrowserDeviceUuid,
    account_id: BrowserDeviceTextId,
    browser_thumbprint: configurationDigest,
    origin: PairingProofOrigin,
    audience: PairingProofAudience,
    configuration_binding_sha256: configurationDigest,
    admission_nonce: configurationDigest,
    action: ConfigurationAction,
    operation_id: BrowserDeviceUuid,
    expected_revision: revision,
    target_sha256: configurationDigest,
    issued_at: configurationTime,
    expires_at: configurationTime,
  })
  .refine((value) =>
    configurationLifetime(value, CONFIGURATION_HARD_MAXIMUMS.admissionMs),
  )
export type ConfigurationAdmissionChallenge = z.infer<
  typeof ConfigurationAdmissionChallenge
>
export const ConfigurationAdmissionProof = z.strictObject({
  challenge: ConfigurationAdmissionChallenge,
  signature: configurationSignature,
})
export type ConfigurationAdmissionProof = z.infer<
  typeof ConfigurationAdmissionProof
>
const admissionCodec = configurationCodec(
  ConfigurationAdmissionProof,
  'configuration admission',
  {
    maxBytes: MAX_CONFIGURATION_PROOF_WIRE_BYTES,
    maxDepth: 3,
    maxValues: 64,
    maxStringChars: 256,
  },
)
export const encodeConfigurationAdmissionProof = admissionCodec.encode
export const decodeConfigurationAdmissionProof = admissionCodec.decode

export function configurationAdmissionPayload(
  input: unknown,
): Uint8Array<ArrayBuffer> {
  return configurationPayload(
    CONFIGURATION_DOMAINS.admission,
    canonicalize(ConfigurationAdmissionChallenge.parse(input)),
  )
}

export async function signConfigurationAdmissionProof(
  input: unknown,
  key: CryptoKey,
): Promise<ConfigurationAdmissionProof> {
  requireP256Private(key, 'configuration admission')
  const challenge = ConfigurationAdmissionChallenge.parse(input)
  const signature = base64url(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        configurationAdmissionPayload(challenge),
      ),
    ),
  )
  const proof = ConfigurationAdmissionProof.parse({ challenge, signature })
  encodeConfigurationAdmissionProof(proof)
  return proof
}

export async function verifyConfigurationAdmissionProof(
  input: unknown,
  publicKey: unknown,
): Promise<boolean> {
  try {
    const proof = ConfigurationAdmissionProof.parse(input)
    encodeConfigurationAdmissionProof(proof)
    const binding = await validateBrowserDevicePublicKey(publicKey)
    if (binding.thumbprint !== proof.challenge.browser_thumbprint) return false
    const key = await crypto.subtle.importKey(
      'jwk',
      binding.publicKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      new Uint8Array(decodeBase64url(proof.signature, 64)),
      configurationAdmissionPayload(proof.challenge),
    )
  } catch {
    return false
  }
}

export type ConfigurationEvidenceRejection =
  | 'malformed'
  | 'capability-signature'
  | 'capability-expired'
  | 'binding-invalid'
  | 'binding-expired'
  | 'context-mismatch'
  | 'action-mismatch'
  | 'operation-mismatch'
  | 'revision-mismatch'
  | 'target-mismatch'
  | 'admission-signature'
  | 'admission-expired'

export interface ConfigurationAuthorityEvidenceInput {
  frame: unknown
  capability: unknown
  admission: unknown
  binding: unknown
  issuerKey: CryptoKey
  now: number
  skewMs?: number
}
export type ConfigurationAuthorityEvidence =
  | {
      ok: true
      /** Marker: nothing below proves live role, revocation, replay or journal state. */
      evidence: 'cryptographic-only'
      claims: SignedConfigurationCapabilityV1
      frame: ConfigurationRequestFrame
      /** Consumers must durably consume this key exactly once before acting. */
      replayKey: {
        capability_id: string
        admission_nonce: string
        operation_id: string
      }
    }
  | { ok: false; reason: ConfigurationEvidenceRejection }

/**
 * Pure cryptographic cross-check of frame, capability, admission proof and the
 * RTC binding. It never claims current authority. The consuming server or
 * Connector must still check live role (owner/admin), revocation, durable replay
 * state, operation journal and revision before acting.
 */
export async function verifyConfigurationAuthorityEvidence(
  input: ConfigurationAuthorityEvidenceInput,
): Promise<ConfigurationAuthorityEvidence> {
  const fail = (
    reason: ConfigurationEvidenceRejection,
  ): ConfigurationAuthorityEvidence => ({ ok: false, reason })
  let frame: ConfigurationRequestFrame
  let claims: SignedConfigurationCapabilityV1
  let proof: ConfigurationAdmissionProof
  try {
    frame = ConfigurationRequestFrame.parse(input.frame)
    claims = SignedConfigurationCapabilityV1.parse(input.capability)
    proof = ConfigurationAdmissionProof.parse(input.admission)
    encodeConfigurationCapability(claims)
    encodeConfigurationAdmissionProof(proof)
  } catch {
    return fail('malformed')
  }
  if (!(await verifyConfigurationCapability(claims, input.issuerKey)))
    return fail('capability-signature')
  if (!configurationFresh(claims, input.now, input.skewMs))
    return fail('capability-expired')
  let binding: Awaited<ReturnType<typeof validateConfigurationSessionBinding>>
  let bindingHash: string
  try {
    binding = await validateConfigurationSessionBinding(input.binding)
    bindingHash = await configurationBindingHash(binding)
  } catch {
    return fail('binding-invalid')
  }
  if (!configurationFresh(binding, input.now, input.skewMs))
    return fail('binding-expired')
  if (
    claims.configuration_binding_sha256 !== bindingHash ||
    claims.account_id !== binding.account_id ||
    claims.farm_id !== binding.farm_id ||
    claims.agent_id !== binding.agent_id ||
    claims.key_id !== binding.key_id ||
    claims.transport_id !== binding.transport_id ||
    claims.browser_thumbprint !== binding.browser_thumbprint ||
    canonicalize(claims.browser_public_key) !==
      canonicalize(binding.browser_public_key) ||
    claims.connector_fingerprint !== binding.connector_fingerprint ||
    claims.credential_jti !== binding.credential_jti ||
    claims.origin !== binding.origin ||
    claims.audience !== binding.audience
  )
    return fail('context-mismatch')
  if (frame.type !== claims.action) return fail('action-mismatch')
  if (frame.operation_id !== claims.operation_id)
    return fail('operation-mismatch')
  if (frame.expected_revision !== claims.expected_revision)
    return fail('revision-mismatch')
  if ((await configurationFrameTargetHash(frame)) !== claims.target_sha256)
    return fail('target-mismatch')
  const challenge = proof.challenge
  if (
    challenge.capability_id !== claims.capability_id ||
    challenge.admission_nonce !== claims.admission_nonce ||
    challenge.configuration_binding_sha256 !== bindingHash ||
    challenge.account_id !== claims.account_id ||
    challenge.farm_id !== claims.farm_id ||
    challenge.agent_id !== claims.agent_id ||
    challenge.key_id !== claims.key_id ||
    challenge.transport_id !== claims.transport_id ||
    challenge.browser_thumbprint !== claims.browser_thumbprint ||
    challenge.origin !== claims.origin ||
    challenge.audience !== claims.audience ||
    challenge.action !== claims.action ||
    challenge.operation_id !== claims.operation_id ||
    challenge.expected_revision !== claims.expected_revision ||
    challenge.target_sha256 !== claims.target_sha256
  )
    return fail('context-mismatch')
  if (
    !configurationFresh(challenge, input.now, input.skewMs) ||
    challenge.expires_at > claims.expires_at
  )
    return fail('admission-expired')
  if (
    !(await verifyConfigurationAdmissionProof(proof, claims.browser_public_key))
  )
    return fail('admission-signature')
  return {
    ok: true,
    evidence: 'cryptographic-only',
    claims,
    frame,
    replayKey: {
      capability_id: claims.capability_id,
      admission_nonce: claims.admission_nonce,
      operation_id: claims.operation_id,
    },
  }
}
