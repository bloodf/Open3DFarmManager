import { z } from 'zod'
import { parseBoundedJson } from './json.ts'

export const PAIRING_TTL_MS = 15 * 60 * 1000
const timestamp = z.number().int().nonnegative()
const uuid = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase(), 'Use lowercase UUIDs')
const bytes32 = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/)
const fingerprint = z
  .string()
  .regex(/^SHA256:[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/)
const userCode = z.string().regex(/^[BCDFGHJKLMNPQRSTVWXZ23456789]{8}$/)

function isEd25519Spki(value: string): boolean {
  try {
    const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '=')
    const prefix = [
      0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ]
    return (
      raw.length === 44 &&
      prefix.every((byte, index) => raw.charCodeAt(index) === byte) &&
      btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') ===
        value
    )
  } catch {
    return false
  }
}
// Structural validation only; proof-of-possession must verify the key cryptographically.
export const PairingPublicKey = z
  .string()
  .length(59)
  .regex(/^[A-Za-z0-9_-]+$/)
  .refine(isEd25519Spki, 'Expected canonical Ed25519 SPKI')
export const PairingStartRequest = z.strictObject({
  public_key_spki: PairingPublicKey,
  platform: z.enum(['linux', 'darwin', 'win32']),
  version: z
    .string()
    .max(64)
    .regex(
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/,
    ),
})
export const PairingStartResponse = z
  .strictObject({
    device_code: bytes32,
    user_code: userCode,
    fingerprint,
    issued_at: timestamp,
    expires_at: timestamp,
    poll_interval_s: z.number().int().min(5).max(60),
  })
  .refine(
    (value) => value.expires_at - value.issued_at === PAIRING_TTL_MS,
    'Pairing must expire after 15 minutes',
  )
export const PairingPollRequest = z.strictObject({ device_code: bytes32 })
export const PairingApprovalRequest = z.strictObject({
  user_code: userCode,
  farm_id: uuid,
  expected_fingerprint: fingerprint,
})
export const PairingPollResponse = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('pending'),
    retry_after_s: z.number().int().min(5).max(60),
  }),
  z.strictObject({
    status: z.literal('slow_down'),
    retry_after_s: z.number().int().min(5).max(300),
  }),
  z.strictObject({
    status: z.literal('approved'),
    agent_id: uuid,
    farm_id: uuid,
    device_token: z
      .string()
      .min(5)
      .max(8192)
      .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
    expires_at: timestamp,
  }),
  z.strictObject({ status: z.literal('expired') }),
  z.strictObject({ status: z.literal('denied') }),
])
export type PairingStartRequest = z.infer<typeof PairingStartRequest>
export type PairingStartResponse = z.infer<typeof PairingStartResponse>
export type PairingPollResponse = z.infer<typeof PairingPollResponse>

/** UI-only normalization; transport schema accepts only the unformatted canonical code. */
export function normalizePairingCode(value: string): string {
  if (value.length > 32) throw new Error('Invalid pairing code')
  const normalized = value.trim().toUpperCase()
  const candidate = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(normalized)
    ? normalized.replace('-', '')
    : normalized
  return userCode.parse(candidate)
}
export function formatPairingCode(value: string): string {
  const code = userCode.parse(value)
  return code.slice(0, 4) + '-' + code.slice(4)
}

/** Response structure does not establish authorization or token validity. */
export function parsePairingResponse(wire: string): PairingPollResponse {
  if (new TextEncoder().encode(wire).byteLength > 12_288)
    throw new Error('Pairing response exceeds size limit')
  return PairingPollResponse.parse(
    parseBoundedJson(wire, {
      maxBytes: 12288,
      maxDepth: 6,
      maxValues: 64,
      maxStringChars: 8192,
    }),
  )
}

/** Bind a start response to the Connector's locally derived fingerprint. */
export function acceptPairingStart(
  input: unknown,
  expectedFingerprint: string,
  now: number,
): PairingStartResponse {
  if (!Number.isSafeInteger(now) || now < 0)
    throw new Error('Invalid pairing clock')
  fingerprint.parse(expectedFingerprint)
  const response = PairingStartResponse.parse(input)
  if (response.fingerprint !== expectedFingerprint)
    throw new Error('Pairing fingerprint mismatch')
  if (now < response.issued_at || now >= response.expires_at)
    throw new Error('Pairing response is not current')
  return response
}
