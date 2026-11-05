import { z } from 'zod'
import { canonicalize } from './canonical.ts'
import { parseBoundedJson } from './json.ts'
import { BrowserDeviceUuid } from './browser-device-proof.ts'
import {
  decodeControlProof,
  MAX_CONTROL_PROOF_WIRE_BYTES,
} from './control-session-binding.ts'
import {
  decodePauseCapability,
  decodePauseAdmissionProof,
  MAX_PAUSE_CAPABILITY_WIRE_BYTES,
  MAX_PAUSE_ADMISSION_WIRE_BYTES,
} from './pause-capability.ts'
import { decodeCommandV2, MAX_COMMAND_V2_WIRE_BYTES } from './command-v2.ts'

// An already-canonical inner JSON string costs at most twice its UTF-8 bytes
// when escaped inside JSON. Fixed outer fields fit within the 1024-byte reserve.
const MAX_INNER_BYTES = Math.max(
  MAX_CONTROL_PROOF_WIRE_BYTES,
  MAX_PAUSE_CAPABILITY_WIRE_BYTES,
  MAX_PAUSE_ADMISSION_WIRE_BYTES,
  MAX_COMMAND_V2_WIRE_BYTES,
)
export const MAX_PAUSE_CHANNEL_WIRE_BYTES = 2 * MAX_INNER_BYTES + 1024
export const MAX_PAUSE_CHANNEL_SEQUENCE = 255
const base = {
  v: z.literal(1),
  transport_id: BrowserDeviceUuid,
  seq: z.number().int().min(0).max(MAX_PAUSE_CHANNEL_SEQUENCE),
}
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const innerWire = z.string().min(1).max(MAX_INNER_BYTES)
/** Shape/correlation only. No decoded frame grants authority or proves peer state. */
export const PauseChannelFrame = z
  .discriminatedUnion('t', [
    z.strictObject({ ...base, t: z.literal('control.proof'), wire: innerWire }),
    z.strictObject({ ...base, t: z.literal('control.proofs-ready') }),
    z.strictObject({
      ...base,
      t: z.literal('control.admission-nonce'),
      admission_nonce: z
        .string()
        .regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/),
      issued_at: time,
      expires_at: time,
    }),
    z.strictObject({
      ...base,
      t: z.literal('control.capability'),
      wire: innerWire,
    }),
    z.strictObject({
      ...base,
      t: z.literal('control.admission-proof'),
      wire: innerWire,
    }),
    z.strictObject({
      ...base,
      t: z.literal('control.command'),
      wire: innerWire,
    }),
    z.strictObject({
      ...base,
      t: z.literal('control.result'),
      command_id: BrowserDeviceUuid,
      outcome: z.enum(['rejected', 'not-sent', 'applied', 'outcome-unknown']),
    }),
    z.strictObject({
      ...base,
      t: z.literal('control.close'),
      reason: z.enum(['closed', 'expired', 'auth-failed', 'capacity']),
    }),
  ])
  .refine((frame) => {
    try {
      switch (frame.t) {
        case 'control.proof':
          return (
            decodeControlProof(frame.wire).binding.transport_id ===
            frame.transport_id
          )
        case 'control.capability':
          return (
            decodePauseCapability(frame.wire).transport_id ===
            frame.transport_id
          )
        case 'control.admission-proof':
          return (
            decodePauseAdmissionProof(frame.wire).challenge.transport_id ===
            frame.transport_id
          )
        case 'control.command':
          return decodeCommandV2(frame.wire).transport_id === frame.transport_id
        case 'control.admission-nonce':
          return (
            frame.expires_at > frame.issued_at &&
            frame.expires_at - frame.issued_at <= 8000
          )
        case 'control.proofs-ready':
        case 'control.result':
        case 'control.close':
          return true
      }
    } catch {
      return false
    }
  })
export type PauseChannelFrame = z.infer<typeof PauseChannelFrame>
export function encodePauseChannelFrame(input: unknown): string {
  const wire = canonicalize(PauseChannelFrame.parse(input))
  if (new TextEncoder().encode(wire).byteLength > MAX_PAUSE_CHANNEL_WIRE_BYTES)
    throw new Error('Pause channel byte limit exceeded')
  return wire
}
export function decodePauseChannelFrame(wire: unknown): PauseChannelFrame {
  if (typeof wire !== 'string' || wire.length > MAX_PAUSE_CHANNEL_WIRE_BYTES)
    throw new Error('Invalid pause channel frame')
  const frame = PauseChannelFrame.parse(
    parseBoundedJson(wire, {
      maxBytes: MAX_PAUSE_CHANNEL_WIRE_BYTES,
      maxDepth: 2,
      maxValues: 16,
      maxStringChars: MAX_INNER_BYTES,
    }),
  )
  if (encodePauseChannelFrame(frame) !== wire)
    throw new Error('Canonical pause channel required')
  return frame
}
