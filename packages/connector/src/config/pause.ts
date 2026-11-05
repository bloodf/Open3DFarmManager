import { z } from 'zod'
import { decodeBase64url } from '../../../farm-protocol/src/encoding.ts'
import { PauseCapabilityV1 } from '../../../farm-protocol/src/pause-capability.ts'
import {
  PairingProofAudience,
  PairingProofOrigin,
} from '../../../farm-protocol/src/pairing-proof.ts'
import type { PauseIssuer } from '../auth/pause-capability.ts'

/**
 * Trusted issuer keyring bound. A larger keyring is refused, never truncated.
 * The bound stays far below the verifier bound because a production Connector
 * trusts a small, explicitly provisioned set of issuers.
 */
export const MAX_PAUSE_ISSUER_KEYRING = 8

/** Canonical Ed25519 SubjectPublicKeyInfo algorithm identifier and key length. */
const ED25519_SPKI_PREFIX = Uint8Array.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
])
const ED25519_SPKI_BYTES = 44
const MIN_PUBLIC_KEY_BYTES = 16
const MAX_PUBLIC_KEY_BYTES = 128

const IssuerEntry = z.strictObject({
  issuer: PauseCapabilityV1.shape.issuer,
  kid: PauseCapabilityV1.shape.kid,
  publicKeySpki: z.string().min(1).max(256),
})

/**
 * A strict, optional pause section of the runtime configuration. It carries
 * independently provisioned signalling settings and trusted issuer keyring.
 */
export const PauseRuntimeConfigSchema = z.strictObject({
  version: z.literal(1),
  issuers: z.array(IssuerEntry).min(1).max(MAX_PAUSE_ISSUER_KEYRING),
  signalling: z
    .strictObject({
      endpoint: z.string().max(2048),
      origin: PairingProofOrigin.refine((value) =>
        value.startsWith('https://'),
      ),
      audience: PairingProofAudience,
      credentialAudience: PairingProofAudience,
    })
    .refine((value) => {
      try {
        const target = new URL(value.endpoint)
        return (
          target.href === value.endpoint &&
          target.protocol === 'wss:' &&
          target.host === new URL(value.origin).host &&
          target.pathname === '/api/signalling/pause-connector' &&
          !target.search &&
          !target.hash &&
          !target.username &&
          !target.password
        )
      } catch {
        return false
      }
    }, 'Expected the exact configured WSS pause Connector endpoint'),
})

export type PauseIssuerEntry = Readonly<{
  issuer: string
  kid: string
  publicKeySpki: string
}>

export type PauseRuntimeConfig = Readonly<{
  version: 1
  issuers: readonly PauseIssuerEntry[]
  signalling: Readonly<z.infer<typeof PauseRuntimeConfigSchema>['signalling']>
}>

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const entry of Object.values(value as Record<string, unknown>))
      deepFreeze(entry)
  }
  return value
}

/**
 * Decodes a canonical, bounded Ed25519 public key in SubjectPublicKeyInfo form.
 *
 * The encoding must be canonical base64url and the DER must be exactly the
 * Ed25519 SPKI. A wrong algorithm, a private PKCS#8 payload, a malformed DER
 * or a trailing byte is refused here, before any key import happens.
 */
function decodeEd25519Spki(encoded: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length % 4 === 1)
    throw new Error('Invalid pause issuer key encoding')
  const size = Math.floor((encoded.length * 6) / 8)
  if (size < MIN_PUBLIC_KEY_BYTES || size > MAX_PUBLIC_KEY_BYTES)
    throw new Error('Invalid pause issuer key length')
  // The protocol decoder re-encodes and compares, so a noncanonical encoding
  // and a truncated payload are refused.
  const bytes = decodeBase64url(encoded, size)
  if (
    bytes.length !== ED25519_SPKI_BYTES ||
    !ED25519_SPKI_PREFIX.every((byte, index) => bytes[index] === byte)
  )
    throw new Error('Expected a canonical Ed25519 public key')
  return bytes
}

/**
 * Parses a present pause section. The runtime reader handles an absent section
 * without calling this parser. Unknown keys, a malformed
 * issuer, a duplicate issuer and kid pair, and any key encoding that is not a
 * canonical Ed25519 public key are refused.
 *
 * The parsed configuration is deeply immutable. No key is imported here: the
 * import is an explicit asynchronous step.
 */
export function parsePauseRuntimeConfig(input: unknown): PauseRuntimeConfig {
  const parsed = PauseRuntimeConfigSchema.parse(input)
  validateIssuerEntries(parsed.issuers)
  return deepFreeze(parsed)
}

function validateIssuerEntries(issuers: readonly PauseIssuerEntry[]): void {
  const seen = new Set<string>()
  for (const entry of issuers) {
    const name = entry.issuer + '\0' + entry.kid
    if (seen.has(name)) throw new Error('Duplicate pause issuer key')
    seen.add(name)
    decodeEd25519Spki(entry.publicKeySpki)
  }
}

/**
 * Loads the trusted issuer keyring as verification-only public keys.
 *
 * This is the only place where a key is imported. It never signs, never
 * generates, never fetches and never caches. An absent configuration performs
 * no cryptographic work at all.
 */
export async function loadPauseIssuerKeys(
  config: PauseRuntimeConfig | null | undefined,
): Promise<readonly PauseIssuer[]> {
  if (!config) return Object.freeze([])
  // Parse and copy the whole configuration before any await can change it.
  const snapshot = parsePauseRuntimeConfig(config)
  const issuers: PauseIssuer[] = []
  for (const entry of snapshot.issuers) {
    const bytes = new Uint8Array(decodeEd25519Spki(entry.publicKeySpki))
    const publicKey = await crypto.subtle.importKey(
      'spki',
      bytes,
      'Ed25519',
      false,
      ['verify'],
    )
    if (
      publicKey.type !== 'public' ||
      publicKey.algorithm.name !== 'Ed25519' ||
      publicKey.usages.length !== 1 ||
      publicKey.usages[0] !== 'verify'
    )
      throw new Error('Expected a trusted Ed25519 verification key')
    issuers.push(
      Object.freeze({
        issuer: entry.issuer,
        kid: entry.kid,
        publicKey,
      }),
    )
  }
  return Object.freeze(issuers)
}
