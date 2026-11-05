import { z } from 'zod'
import { parseBoundedJson } from './json.ts'
import { BrowserDeviceUuid } from './browser-device-proof.ts'
import { BrowserTransportProofChallenge } from './browser-transport-proof.ts'
import { CredentialProofChallenge } from './credential-proof.ts'
import { RtcSessionBinding } from './rtc-session-binding.ts'
import { AuthenticatedSignallingFrame } from './authenticated-signalling.ts'
const signallingChallenge = CredentialProofChallenge.refine(
  (value) => value.purpose === 'signalling',
)
const signature = z.string().regex(/^[A-Za-z0-9_-]{85}[AQgw]$/)
const base = { v: z.literal(1) }
const token = z.string().min(1).max(8192)
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const SignallingClientControl = z.discriminatedUnion('t', [
  z.strictObject({
    ...base,
    t: z.literal('browser.begin'),
    farm_id: BrowserDeviceUuid,
    agent_id: BrowserDeviceUuid,
    key_id: BrowserDeviceUuid,
  }),
  z.strictObject({ ...base, t: z.literal('browser.proof'), signature }),
  // jti selects an exact current record; it is never trusted without JWT and PoP.
  z.strictObject({
    ...base,
    t: z.literal('connector.begin'),
    farm_id: BrowserDeviceUuid,
    agent_id: BrowserDeviceUuid,
    jti: BrowserDeviceUuid,
    token,
  }),
  z.strictObject({ ...base, t: z.literal('connector.inbox-proof'), signature }),
  z.strictObject({ ...base, t: z.literal('connector.attach'), token }),
  z.strictObject({
    ...base,
    t: z.literal('connector.context-proof'),
    signature,
  }),
  z.strictObject({ ...base, t: z.literal('connector.retry') }),
])
export type SignallingClientControl = z.infer<typeof SignallingClientControl>
export const SignallingClientFrame = z.union([
  SignallingClientControl,
  AuthenticatedSignallingFrame,
])
export type SignallingClientFrame = z.infer<typeof SignallingClientFrame>
const lease = {
  issued_at: timestamp,
  expires_at: timestamp,
  commands_enabled: z.literal(false),
}
export const SignallingServerControl = z
  .discriminatedUnion('t', [
    z.strictObject({
      ...base,
      t: z.literal('browser.challenge'),
      challenge: BrowserTransportProofChallenge,
    }),
    z.strictObject({
      ...base,
      t: z.literal('connector.inbox-challenge'),
      challenge: signallingChallenge,
    }),
    z.strictObject({
      ...base,
      t: z.literal('connector.inbox-ready'),
      inbox_id: BrowserDeviceUuid,
      ...lease,
    }),
    z.strictObject({
      ...base,
      t: z.literal('connector.context-request'),
      transport_id: BrowserDeviceUuid,
      ...lease,
    }),
    z.strictObject({
      ...base,
      t: z.literal('connector.context-challenge'),
      challenge: signallingChallenge,
    }),
    z.strictObject({
      ...base,
      t: z.literal('rtc.ready'),
      transport_id: BrowserDeviceUuid,
      ...lease,
    }),
    z.strictObject({
      ...base,
      t: z.literal('rtc.binding'),
      binding: RtcSessionBinding,
    }),
    z.strictObject({
      ...base,
      t: z.literal('retry'),
      phase: z.enum(['inbox', 'context']),
      retry_after_ms: z.number().int().min(1).max(60000),
    }),
  ])
  .refine(
    (frame) =>
      !('issued_at' in frame) ||
      (frame.expires_at > frame.issued_at &&
        frame.expires_at - frame.issued_at <= 30000),
  )
export const SignallingServerFrame = z.union([
  SignallingServerControl,
  AuthenticatedSignallingFrame,
])
export type SignallingServerFrame = z.infer<typeof SignallingServerFrame>
export const MAX_SIGNALLING_SOCKET_BYTES = 12 * 1024
function parse(wire: unknown): unknown {
  if (
    typeof wire !== 'string' ||
    wire.length > MAX_SIGNALLING_SOCKET_BYTES ||
    utf8Bytes(wire) > MAX_SIGNALLING_SOCKET_BYTES
  )
    throw new Error('Invalid signalling socket frame')
  return parseBoundedJson(wire, {
    maxBytes: MAX_SIGNALLING_SOCKET_BYTES,
    maxDepth: 7,
    maxValues: 96,
    maxStringChars: 8192,
  })
}
function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength
}
export function decodeSignallingClientFrame(
  wire: unknown,
): SignallingClientFrame {
  return SignallingClientFrame.parse(parse(wire))
}
export function decodeSignallingServerFrame(
  wire: unknown,
): SignallingServerFrame {
  return SignallingServerFrame.parse(parse(wire))
}
export function encodeSignallingServerFrame(
  input: SignallingServerFrame,
): string {
  const wire = JSON.stringify(SignallingServerFrame.parse(input))
  if (utf8Bytes(wire) > MAX_SIGNALLING_SOCKET_BYTES)
    throw new Error('Signalling socket frame too large')
  return wire
}
export function encodeSignallingClientFrame(
  input: SignallingClientFrame,
): string {
  const wire = JSON.stringify(SignallingClientFrame.parse(input))
  if (utf8Bytes(wire) > MAX_SIGNALLING_SOCKET_BYTES)
    throw new Error('Signalling socket frame too large')
  return wire
}
