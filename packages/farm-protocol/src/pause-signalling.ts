import { z } from 'zod'
import { canonicalize } from './canonical.ts'
import { parseBoundedJson } from './json.ts'
import { base64url, decodeBase64url } from './encoding.ts'
import {
  BrowserDeviceUuid,
  BrowserDeviceTextId,
  validateBrowserDevicePublicKey,
} from './browser-device-proof.ts'
import { PairingProofOrigin, PairingProofAudience } from './pairing-proof.ts'
import { CredentialProofChallenge } from './credential-proof.ts'
import { ControlSessionBinding } from './control-session-binding.ts'
import { AuthenticatedSignallingFrame } from './authenticated-signalling.ts'

export const MAX_PAUSE_SIGNALLING_WIRE_BYTES = 12288
export const MAX_PAUSE_TRANSPORT_ADMISSION_MS = 8000
export const MAX_PAUSE_TRANSPORT_LIFETIME_MS = 30000
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const digest = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/)
const signature = z.string().regex(/^[A-Za-z0-9_-]{85}[AQgw]$/)
const scope = {
  transport_id: BrowserDeviceUuid,
  farm_id: BrowserDeviceUuid,
  agent_id: BrowserDeviceUuid,
  assignment_id: BrowserDeviceUuid,
}
const lifetime =
  (maximum: number) => (value: { issued_at: number; expires_at: number }) =>
    value.expires_at > value.issued_at &&
    value.expires_at - value.issued_at <= maximum

/** Transport proof only: current authority and actual RTC proofs remain separate. */
export const PauseTransportProofChallenge = z
  .strictObject({
    v: z.literal(1),
    purpose: z.literal('pause-signalling-admission'),
    ...scope,
    key_id: BrowserDeviceUuid,
    account_id: BrowserDeviceTextId,
    thumbprint: digest,
    origin: PairingProofOrigin,
    audience: PairingProofAudience,
    nonce: digest,
    issued_at: time,
    expires_at: time,
  })
  .refine(lifetime(MAX_PAUSE_TRANSPORT_ADMISSION_MS))
export type PauseTransportProofChallenge = z.infer<
  typeof PauseTransportProofChallenge
>

function bounded(value: unknown): string {
  const wire = canonicalize(value)
  if (
    new TextEncoder().encode(wire).byteLength > MAX_PAUSE_SIGNALLING_WIRE_BYTES
  )
    throw new Error('Pause signalling byte limit exceeded')
  return wire
}
export function pauseTransportProofPayload(
  input: unknown,
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    'Open3DFarmManager/pause-transport-proof/v1\0' +
      bounded(PauseTransportProofChallenge.parse(input)),
  )
}
/** Caller must independently pin the fresh expected scope before invoking this primitive. */
export async function signPauseTransportProof(
  input: unknown,
  key: CryptoKey,
): Promise<string> {
  if (
    key.type !== 'private' ||
    key.extractable ||
    key.algorithm.name !== 'ECDSA' ||
    !('namedCurve' in key.algorithm) ||
    key.algorithm.namedCurve !== 'P-256'
  )
    throw new Error('Nonextractable P-256 private key required')
  return base64url(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        pauseTransportProofPayload(input),
      ),
    ),
  )
}
export async function verifyPauseTransportProof(
  input: unknown,
  publicKey: unknown,
  sig: unknown,
): Promise<boolean> {
  try {
    const challenge = PauseTransportProofChallenge.parse(input)
    const browser = await validateBrowserDevicePublicKey(publicKey)
    if (browser.thumbprint !== challenge.thumbprint) return false
    const key = await crypto.subtle.importKey(
      'jwk',
      browser.publicKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      new Uint8Array(decodeBase64url(signature.parse(sig), 64)),
      pauseTransportProofPayload(challenge),
    )
  } catch {
    return false
  }
}

const base = { v: z.literal(1) }
const token = z.string().min(1).max(8192)
const lease = {
  issued_at: time,
  expires_at: time,
  commands_enabled: z.literal(false),
}
const credentialChallenge = CredentialProofChallenge.refine(
  (value) => value.purpose === 'signalling',
)
const ClientControl = z.discriminatedUnion('t', [
  z.strictObject({
    ...base,
    t: z.literal('pause.begin'),
    farm_id: BrowserDeviceUuid,
    agent_id: BrowserDeviceUuid,
    key_id: BrowserDeviceUuid,
    assignment_id: BrowserDeviceUuid,
  }),
  z.strictObject({ ...base, t: z.literal('pause.browser-proof'), signature }),
  z.strictObject({
    ...base,
    t: z.literal('pause.connector-begin'),
    farm_id: BrowserDeviceUuid,
    agent_id: BrowserDeviceUuid,
    jti: BrowserDeviceUuid,
    token,
  }),
  z.strictObject({
    ...base,
    t: z.literal('pause.connector-inbox-proof'),
    signature,
  }),
  z.strictObject({
    ...base,
    t: z.literal('pause.connector-attach'),
    ...scope,
    token,
  }),
  z.strictObject({
    ...base,
    t: z.literal('pause.connector-context-proof'),
    signature,
  }),
  z.strictObject({ ...base, t: z.literal('pause.connector-retry') }),
])
export const PauseSignallingClientFrame = z.union([
  ClientControl,
  AuthenticatedSignallingFrame,
])
export type PauseSignallingClientFrame = z.infer<
  typeof PauseSignallingClientFrame
>
const ServerControl = z
  .discriminatedUnion('t', [
    z.strictObject({
      ...base,
      t: z.literal('pause.challenge'),
      challenge: PauseTransportProofChallenge,
    }),
    z.strictObject({
      ...base,
      t: z.literal('pause.connector-inbox-challenge'),
      challenge: credentialChallenge,
    }),
    z.strictObject({
      ...base,
      t: z.literal('pause.connector-inbox-ready'),
      inbox_id: BrowserDeviceUuid,
      ...lease,
    }),
    z.strictObject({
      ...base,
      t: z.literal('pause.context-request'),
      ...scope,
      ...lease,
    }),
    z.strictObject({
      ...base,
      t: z.literal('pause.context-challenge'),
      ...scope,
      challenge: credentialChallenge,
    }),
    z.strictObject({
      ...base,
      t: z.literal('pause.ready'),
      ...scope,
      ...lease,
    }),
    z.strictObject({
      ...base,
      t: z.literal('pause.binding'),
      binding: ControlSessionBinding,
    }),
    z.strictObject({
      ...base,
      t: z.literal('pause.retry'),
      phase: z.enum(['inbox', 'context']),
      retry_after_ms: z.number().int().min(1).max(60000),
    }),
  ])
  .refine(
    (frame) =>
      !('issued_at' in frame) ||
      lifetime(MAX_PAUSE_TRANSPORT_LIFETIME_MS)(frame),
  )
  .refine(
    (frame) =>
      frame.t !== 'pause.context-challenge' ||
      (frame.challenge.connection_id === frame.transport_id &&
        frame.challenge.agent_id === frame.agent_id &&
        frame.challenge.farm_id === frame.farm_id),
  )
export const PauseSignallingServerFrame = z.union([
  ServerControl,
  AuthenticatedSignallingFrame,
])
export type PauseSignallingServerFrame = z.infer<
  typeof PauseSignallingServerFrame
>
function parse(wire: unknown): unknown {
  if (typeof wire !== 'string' || wire.length > MAX_PAUSE_SIGNALLING_WIRE_BYTES)
    throw new Error('Invalid pause signalling frame')
  return parseBoundedJson(wire, {
    maxBytes: MAX_PAUSE_SIGNALLING_WIRE_BYTES,
    maxDepth: 7,
    maxValues: 128,
    maxStringChars: 8192,
  })
}
export function encodePauseSignallingClientFrame(input: unknown): string {
  return bounded(PauseSignallingClientFrame.parse(input))
}
export function encodePauseSignallingServerFrame(input: unknown): string {
  return bounded(PauseSignallingServerFrame.parse(input))
}
export function decodePauseSignallingClientFrame(
  wire: unknown,
): PauseSignallingClientFrame {
  const frame = PauseSignallingClientFrame.parse(parse(wire))
  if (encodePauseSignallingClientFrame(frame) !== wire)
    throw new Error('Canonical pause signalling required')
  return frame
}
export function decodePauseSignallingServerFrame(
  wire: unknown,
): PauseSignallingServerFrame {
  const frame = PauseSignallingServerFrame.parse(parse(wire))
  if (encodePauseSignallingServerFrame(frame) !== wire)
    throw new Error('Canonical pause signalling required')
  return frame
}
