import { z } from 'zod'
import { canonicalize } from './canonical.ts'
import { parseBoundedJson } from './json.ts'
import { base64url, decodeBase64url } from './encoding.ts'
import {
  BrowserDeviceUuid,
  BrowserDeviceTextId,
  validateBrowserDevicePublicKey,
} from './browser-device-proof.ts'

export const MAX_COMMAND_V2_WIRE_BYTES = 8192
export const MAX_COMMAND_V2_LIFETIME_MS = 5000
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const fields = {
  v: z.literal(2),
  purpose: z.literal('printer-pause'),
  cmd_id: BrowserDeviceUuid,
  farm_id: BrowserDeviceUuid,
  agent_id: BrowserDeviceUuid,
  account_id: BrowserDeviceTextId,
  key_id: BrowserDeviceUuid,
  transport_id: BrowserDeviceUuid,
  capability_id: BrowserDeviceUuid,
  assignment_id: BrowserDeviceUuid,
  action: z.literal('pause'),
  args: z.strictObject({}),
  issued_at: time,
  expires_at: time,
  nonce: z.string().regex(/^[A-Za-z0-9_-]{21}[AQgw]$/),
}
const lifetime = (value: { issued_at: number; expires_at: number }) =>
  value.expires_at > value.issued_at &&
  value.expires_at - value.issued_at <= MAX_COMMAND_V2_LIFETIME_MS
export const UnsignedCommandV2 = z.strictObject(fields).refine(lifetime)
export type UnsignedCommandV2 = z.infer<typeof UnsignedCommandV2>
export const SignedCommandV2 = z
  .strictObject({
    ...fields,
    sig: z.string().regex(/^[A-Za-z0-9_-]{85}[AQgw]$/),
  })
  .refine(lifetime)
export type SignedCommandV2 = z.infer<typeof SignedCommandV2>
export const CommandV2 = UnsignedCommandV2
export type CommandV2 = UnsignedCommandV2
export function encodeCommandV2(input: unknown): string {
  const wire = canonicalize(SignedCommandV2.parse(input))
  if (new TextEncoder().encode(wire).byteLength > MAX_COMMAND_V2_WIRE_BYTES)
    throw new Error('Command v2 byte limit exceeded')
  return wire
}
export function decodeCommandV2(wire: unknown): SignedCommandV2 {
  if (typeof wire !== 'string' || wire.length > MAX_COMMAND_V2_WIRE_BYTES)
    throw new Error('Invalid command v2 frame')
  const parsed = SignedCommandV2.parse(
    parseBoundedJson(wire, {
      maxBytes: MAX_COMMAND_V2_WIRE_BYTES,
      maxDepth: 3,
      maxValues: 32,
      maxStringChars: 128,
    }),
  )
  if (encodeCommandV2(parsed) !== wire)
    throw new Error('Canonical command v2 required')
  return parsed
}
export function commandV2Payload(input: unknown): Uint8Array<ArrayBuffer> {
  const wire = canonicalize(UnsignedCommandV2.parse(input))
  if (new TextEncoder().encode(wire).byteLength > MAX_COMMAND_V2_WIRE_BYTES)
    throw new Error('Command v2 byte limit exceeded')
  return new TextEncoder().encode(
    'Open3DFarmManager/printer-command/v2\0' + wire,
  )
}
/** Cryptographic helper only. Caller must establish capability, scope, freshness and live peer authority separately. */
export async function signCommandV2(
  input: unknown,
  key: CryptoKey,
): Promise<SignedCommandV2> {
  if (
    key.type !== 'private' ||
    key.extractable ||
    key.algorithm.name !== 'ECDSA' ||
    !('namedCurve' in key.algorithm) ||
    key.algorithm.namedCurve !== 'P-256'
  )
    throw new Error('Nonextractable P-256 private key required')
  const command = UnsignedCommandV2.parse(input)
  const sig = base64url(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        commandV2Payload(command),
      ),
    ),
  )
  const signed = SignedCommandV2.parse({ ...command, sig })
  encodeCommandV2(signed)
  return signed
}
export async function verifyCommandV2(
  input: unknown,
  publicKey: unknown,
): Promise<boolean> {
  try {
    const { sig, ...command } = SignedCommandV2.parse(input)
    const binding = await validateBrowserDevicePublicKey(publicKey)
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
      new Uint8Array(decodeBase64url(sig, 64)),
      commandV2Payload(command),
    )
  } catch {
    return false
  }
}
