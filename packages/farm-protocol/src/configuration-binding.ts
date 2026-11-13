import { z } from 'zod'
import { base64url, decodeBase64url } from './encoding.ts'
import {
  BrowserDeviceUuid,
  BrowserDeviceTextId,
  BrowserDevicePublicKey,
  validateBrowserDevicePublicKey,
} from './browser-device-proof.ts'
import { PairingPublicKey } from './pairing.ts'
import { PairingProofOrigin, PairingProofAudience } from './pairing-proof.ts'
import {
  controlDtlsFingerprint,
  controlSdpHash,
} from './control-session-binding.ts'
import {
  CONFIGURATION_DOMAINS,
  CONFIGURATION_HARD_MAXIMUMS,
  CONFIGURATION_PROTOCOL,
  MAX_CONFIGURATION_PROOF_WIRE_BYTES,
  configurationBounded,
  configurationCodec,
  configurationDigest,
  configurationDtls,
  configurationFingerprint,
  configurationHash,
  configurationLifetime,
  configurationPayload,
  configurationSignature,
  configurationTime,
  requireEd25519Private,
  requireP256Private,
} from './configuration-common.ts'

/**
 * Authenticated RTC session binding for printer configuration. No assignment
 * is part of it: a freshly paired Connector has no printers yet. It is NOT
 * interchangeable with the pause `ControlSessionBinding`.
 */
export const ConfigurationSessionBinding = z
  .strictObject({
    v: z.literal(1),
    purpose: z.literal('configuration-rtc'),
    protocol: z.literal(CONFIGURATION_PROTOCOL),
    transport_id: BrowserDeviceUuid,
    farm_id: BrowserDeviceUuid,
    agent_id: BrowserDeviceUuid,
    account_id: BrowserDeviceTextId,
    key_id: BrowserDeviceUuid,
    browser_public_key: BrowserDevicePublicKey,
    browser_thumbprint: configurationDigest,
    connector_public_key_spki: PairingPublicKey,
    connector_fingerprint: configurationFingerprint,
    credential_jti: BrowserDeviceUuid,
    origin: PairingProofOrigin,
    audience: PairingProofAudience,
    browser_nonce: configurationDigest,
    connector_nonce: configurationDigest,
    issued_at: configurationTime,
    expires_at: configurationTime,
    offer_sha256: configurationDigest,
    answer_sha256: configurationDigest,
    browser_dtls: configurationDtls,
    connector_dtls: configurationDtls,
  })
  .refine(
    (v) =>
      configurationLifetime(v, CONFIGURATION_HARD_MAXIMUMS.bindingMs) &&
      v.browser_nonce !== v.connector_nonce &&
      v.browser_dtls !== v.connector_dtls,
  )
export type ConfigurationSessionBinding = z.infer<
  typeof ConfigurationSessionBinding
>
export type ConfigurationPeerRole = 'browser' | 'connector'

export const BrowserConfigurationProof = z.strictObject({
  v: z.literal(1),
  role: z.literal('browser'),
  binding: ConfigurationSessionBinding,
  signature: configurationSignature,
})
export const ConnectorConfigurationProof = z.strictObject({
  v: z.literal(1),
  role: z.literal('connector'),
  binding: ConfigurationSessionBinding,
  signature: configurationSignature,
})
export const ConfigurationSessionProof = z.discriminatedUnion('role', [
  BrowserConfigurationProof,
  ConnectorConfigurationProof,
])
export type ConfigurationSessionProof = z.infer<
  typeof ConfigurationSessionProof
>

const proofCodec = configurationCodec(
  ConfigurationSessionProof,
  'configuration proof',
  {
    maxBytes: MAX_CONFIGURATION_PROOF_WIRE_BYTES,
    maxDepth: 4,
    maxValues: 100,
    maxStringChars: 256,
  },
)
export const encodeConfigurationSessionProof = proofCodec.encode
export const decodeConfigurationSessionProof = proofCodec.decode

function boundedBinding(input: unknown): string {
  return configurationBounded(
    ConfigurationSessionBinding.parse(input),
    MAX_CONFIGURATION_PROOF_WIRE_BYTES,
    'Configuration binding',
  )
}

function assertRole(role: unknown): asserts role is ConfigurationPeerRole {
  if (role !== 'browser' && role !== 'connector')
    throw new Error('Invalid configuration proof role')
}

async function connectorKey(input: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'spki',
    new Uint8Array(decodeBase64url(PairingPublicKey.parse(input), 44)),
    { name: 'Ed25519' },
    false,
    ['verify'],
  )
}

export async function connectorFingerprintFromSpki(
  spki: string,
): Promise<string> {
  return (
    'SHA256:' +
    base64url(
      new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          new Uint8Array(decodeBase64url(PairingPublicKey.parse(spki), 44)),
        ),
      ),
    )
  )
}

/** Validates native key material and self-consistency, not enrollment or peer provenance. */
export async function validateConfigurationSessionBinding(
  input: unknown,
): Promise<ConfigurationSessionBinding> {
  const binding = ConfigurationSessionBinding.parse(input)
  boundedBinding(binding)
  const browser = await validateBrowserDevicePublicKey(
    binding.browser_public_key,
  )
  await connectorKey(binding.connector_public_key_spki)
  if (
    browser.thumbprint !== binding.browser_thumbprint ||
    (await connectorFingerprintFromSpki(binding.connector_public_key_spki)) !==
      binding.connector_fingerprint
  )
    throw new Error('Configuration key binding mismatch')
  return binding
}

export function configurationSessionProofPayload(
  input: unknown,
  role: ConfigurationPeerRole,
): Uint8Array<ArrayBuffer> {
  assertRole(role)
  return configurationPayload(
    CONFIGURATION_DOMAINS.bindingProof,
    boundedBinding(input),
    role,
  )
}

/** Hash the capability and admission proof use to pin one RTC session. */
export async function configurationBindingHash(
  input: unknown,
): Promise<string> {
  return configurationHash(
    CONFIGURATION_DOMAINS.bindingHash,
    boundedBinding(input),
  )
}

/** Trusted-key primitive. Real Connector identities keep their private key encapsulated. */
export async function signConfigurationSessionProof(
  input: unknown,
  role: ConfigurationPeerRole,
  key: CryptoKey,
): Promise<string> {
  assertRole(role)
  if (role === 'browser') requireP256Private(key, 'configuration')
  else requireEd25519Private(key, 'configuration')
  const binding = await validateConfigurationSessionBinding(input)
  const signature = base64url(
    new Uint8Array(
      await crypto.subtle.sign(
        role === 'browser'
          ? { name: 'ECDSA', hash: 'SHA-256' }
          : { name: 'Ed25519' },
        key,
        configurationSessionProofPayload(binding, role),
      ),
    ),
  )
  encodeConfigurationSessionProof({ v: 1, role, binding, signature })
  return signature
}

export async function verifyConfigurationSessionProof(
  input: unknown,
  role: ConfigurationPeerRole,
  sig: string,
): Promise<boolean> {
  try {
    assertRole(role)
    configurationSignature.parse(sig)
    const binding = await validateConfigurationSessionBinding(input)
    const key =
      role === 'browser'
        ? await crypto.subtle.importKey(
            'jwk',
            binding.browser_public_key,
            { name: 'ECDSA', namedCurve: 'P-256' },
            false,
            ['verify'],
          )
        : await connectorKey(binding.connector_public_key_spki)
    return await crypto.subtle.verify(
      role === 'browser'
        ? { name: 'ECDSA', hash: 'SHA-256' }
        : { name: 'Ed25519' },
      key,
      new Uint8Array(decodeBase64url(sig, 64)),
      configurationSessionProofPayload(binding, role),
    )
  } catch {
    return false
  }
}

/**
 * Checks the binding against the exact negotiated descriptions. Offer/answer
 * hashes and DTLS pins must match; relay candidates are rejected by the SDP
 * helpers. Does not replace the real DTLS certificate check of the transport.
 */
export async function configurationBindingFromDescriptions(
  input: unknown,
  role: ConfigurationPeerRole,
  localSdp: string,
  remoteSdp: string,
): Promise<ConfigurationSessionBinding> {
  assertRole(role)
  const binding = await validateConfigurationSessionBinding(input)
  const local = controlDtlsFingerprint(localSdp)
  const remote = controlDtlsFingerprint(remoteSdp)
  const offer = role === 'connector' ? localSdp : remoteSdp
  const answer = role === 'browser' ? localSdp : remoteSdp
  if (
    binding.offer_sha256 !== (await controlSdpHash(offer)) ||
    binding.answer_sha256 !== (await controlSdpHash(answer)) ||
    binding.browser_dtls !== (role === 'browser' ? local : remote) ||
    binding.connector_dtls !== (role === 'connector' ? local : remote)
  )
    throw new Error('Configuration descriptions do not match binding')
  return binding
}

/** Mutual verification result. Cryptographic only; says nothing about current authority. */
export async function verifyConfigurationSessionPair(
  browser: unknown,
  connector: unknown,
  descriptions?: {
    role: ConfigurationPeerRole
    localSdp: string
    remoteSdp: string
  },
): Promise<ConfigurationSessionBinding | null> {
  try {
    const b = BrowserConfigurationProof.parse(browser)
    const c = ConnectorConfigurationProof.parse(connector)
    encodeConfigurationSessionProof(b)
    encodeConfigurationSessionProof(c)
    if (
      (await configurationBindingHash(b.binding)) !==
      (await configurationBindingHash(c.binding))
    )
      return null
    if (
      !(await verifyConfigurationSessionProof(
        b.binding,
        'browser',
        b.signature,
      )) ||
      !(await verifyConfigurationSessionProof(
        c.binding,
        'connector',
        c.signature,
      ))
    )
      return null
    if (descriptions)
      await configurationBindingFromDescriptions(
        b.binding,
        descriptions.role,
        descriptions.localSdp,
        descriptions.remoteSdp,
      )
    return b.binding
  } catch {
    return null
  }
}
