import { z } from 'zod'
import { canonicalize } from './canonical.ts'
import { parseBoundedJson } from './json.ts'
import { base64url } from './encoding.ts'

/**
 * Shared primitives for the config-v1 printer onboarding contract.
 *
 * Every signature and hash below uses a domain that is unique to config-v1.
 * Pause, read-only, pairing and browser-device proofs can never be replayed
 * as configuration evidence, and the reverse. Schema or signature validity is
 * cryptographic evidence only. Current authority (live role, revocation,
 * replay ledger, durable journal) belongs to the consuming server/Connector.
 */
export const CONFIGURATION_PROTOCOL = 'config-v1'
export const CONFIGURATION_HARD_MAXIMUMS = Object.freeze({
  bindingMs: 30_000,
  capabilityMs: 30_000,
  admissionMs: 8_000,
  skewMs: 5_000,
})
export const MAX_CONFIGURATION_FRAME_WIRE_BYTES = 16_384
export const MAX_CONFIGURATION_PROOF_WIRE_BYTES = 8_192

export const CONFIGURATION_DOMAINS = Object.freeze({
  bindingProof: 'Open3DFarmManager/configuration-session-proof/config-v1\0',
  bindingHash: 'Open3DFarmManager/configuration-session-hash/config-v1\0',
  capability: 'Open3DFarmManager/configuration-capability/config-v1\0',
  admission: 'Open3DFarmManager/configuration-admission/config-v1\0',
  receipt: 'Open3DFarmManager/configuration-receipt/config-v1\0',
  receiptHash: 'Open3DFarmManager/configuration-receipt-hash/config-v1\0',
  targetHash: 'Open3DFarmManager/configuration-target-hash/config-v1\0',
})

export const configurationTime = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
export const configurationDigest = z
  .string()
  .regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/)
export const configurationSignature = z
  .string()
  .regex(/^[A-Za-z0-9_-]{85}[AQgw]$/)
export const configurationFingerprint = z
  .string()
  .regex(/^SHA256:[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/)
export const configurationDtls = z
  .string()
  .regex(/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/)
/** Opaque nonsecret identifier. Never a name, address, URL or credential. */
export const configurationOpaqueId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/)
export const ConfigurationRole = z.enum(['owner', 'admin'])
export type ConfigurationRole = z.infer<typeof ConfigurationRole>
export const ConfigurationAction = z.enum([
  'prepare',
  'commit',
  'status',
  'cancel',
])
export type ConfigurationAction = z.infer<typeof ConfigurationAction>

export interface ConfigurationWireLimits {
  maxBytes: number
  maxDepth: number
  maxValues: number
  maxStringChars: number
}

export function configurationBounded(
  value: unknown,
  maxBytes: number,
  label: string,
): string {
  const wire = canonicalize(value)
  if (new TextEncoder().encode(wire).byteLength > maxBytes)
    throw new Error(`${label} byte limit exceeded`)
  return wire
}

export interface ConfigurationCodec<T> {
  encode(input: unknown): string
  decode(wire: unknown): T
}

/** Canonical-only strict codec: schema, size, depth, count and string bounds. */
export function configurationCodec<T>(
  schema: z.ZodType<T>,
  label: string,
  limits: ConfigurationWireLimits,
): ConfigurationCodec<T> {
  const encode = (input: unknown): string =>
    configurationBounded(schema.parse(input), limits.maxBytes, label)
  return {
    encode,
    decode(wire: unknown): T {
      if (typeof wire !== 'string' || wire.length > limits.maxBytes)
        throw new Error(`Invalid ${label} frame`)
      const parsed = schema.parse(parseBoundedJson(wire, limits))
      if (encode(parsed) !== wire)
        throw new Error(`Canonical ${label} required`)
      return parsed
    },
  }
}

export function configurationPayload(
  domain: string,
  canonicalBody: string,
  role?: string,
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    domain + (role === undefined ? '' : role + '\0') + canonicalBody,
  )
}

export async function configurationHash(
  domain: string,
  canonicalBody: string,
): Promise<string> {
  return base64url(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(domain + canonicalBody),
      ),
    ),
  )
}

export function requireEd25519Private(key: CryptoKey, label: string): void {
  if (
    key.type !== 'private' ||
    key.extractable ||
    key.algorithm.name !== 'Ed25519'
  )
    throw new Error(`Trusted nonextractable Ed25519 ${label} key required`)
}

export function requireP256Private(key: CryptoKey, label: string): void {
  if (
    key.type !== 'private' ||
    key.extractable ||
    key.algorithm.name !== 'ECDSA' ||
    !('namedCurve' in key.algorithm) ||
    key.algorithm.namedCurve !== 'P-256'
  )
    throw new Error(`Nonextractable P-256 ${label} key required`)
}

export function configurationLifetime(
  value: { issued_at: number; expires_at: number },
  maxMs: number,
): boolean {
  return (
    value.expires_at > value.issued_at &&
    value.expires_at - value.issued_at <= maxMs
  )
}

/** Strict window check with bounded skew. Never accepts expiry-equal instants. */
export function configurationFresh(
  value: { issued_at: number; expires_at: number },
  now: number,
  skewMs = 0,
): boolean {
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(skewMs) ||
    skewMs < 0 ||
    skewMs > CONFIGURATION_HARD_MAXIMUMS.skewMs
  )
    return false
  return value.issued_at - skewMs <= now && now < value.expires_at
}
