import { z } from 'zod'
import { parseBoundedJson } from './json.ts'
import { BrowserDeviceUuid } from './browser-device-proof.ts'
import { rtcDtlsFingerprint } from './rtc-session-binding.ts'
const base = {
  v: z.literal(1),
  transport_id: BrowserDeviceUuid,
  seq: z.number().int().min(0).max(255),
}
const sdp = z
  .string()
  .min(1)
  .max(7000)
  .refine((value) => {
    try {
      rtcDtlsFingerprint(value)
      return true
    } catch {
      return false
    }
  })
const candidate = z
  .string()
  .max(2048)
  .refine(
    (value) =>
      value === '' ||
      (!/[\r\n\0]/.test(value) &&
        /^candidate:[^ ]+ [0-9]+ (?:udp|tcp) [0-9]+ [^ ]+ [0-9]+ typ (?:host|srflx|prflx)(?: |$)/i.test(
          value,
        )),
  )
export const AuthenticatedSignallingFrame = z.discriminatedUnion('t', [
  z.strictObject({
    ...base,
    t: z.literal('rtc.offer'),
    p: z.strictObject({ sdp }),
  }),
  z.strictObject({
    ...base,
    t: z.literal('rtc.answer'),
    p: z.strictObject({ sdp }),
  }),
  z.strictObject({
    ...base,
    t: z.literal('rtc.ice'),
    p: z.strictObject({
      candidate,
      sdpMid: z.string().max(256).nullable(),
      sdpMLineIndex: z.number().int().min(0).max(65535).nullable(),
    }),
  }),
  z.strictObject({
    ...base,
    t: z.literal('rtc.close'),
    p: z.strictObject({
      reason: z.enum(['closed', 'expired', 'auth-failed', 'capacity']),
    }),
  }),
])
export type AuthenticatedSignallingFrame = z.infer<
  typeof AuthenticatedSignallingFrame
>
export function decodeAuthenticatedSignallingFrame(
  wire: unknown,
): AuthenticatedSignallingFrame {
  if (typeof wire !== 'string' || wire.length > 8192)
    throw new Error('Invalid signalling frame')
  return AuthenticatedSignallingFrame.parse(
    parseBoundedJson(wire, {
      maxBytes: 8192,
      maxDepth: 5,
      maxValues: 32,
      maxStringChars: 7000,
    }),
  )
}
