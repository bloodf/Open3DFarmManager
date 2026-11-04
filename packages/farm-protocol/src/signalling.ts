import { z } from 'zod'
import { parseBoundedJson } from './json.ts'

const base = { id: z.string().uuid(), ts: z.number().int().nonnegative() }
const peer = { agent_id: z.string().uuid(), viewer_id: z.string().uuid() }
export const Signalling = z.discriminatedUnion('t', [
  z.strictObject({
    ...base,
    t: z.literal('rtc.offer'),
    p: z.strictObject({ ...peer, sdp: z.string().min(1).max(7000) }),
  }),
  z.strictObject({
    ...base,
    t: z.literal('rtc.answer'),
    p: z.strictObject({ ...peer, sdp: z.string().min(1).max(7000) }),
  }),
  z.strictObject({
    ...base,
    t: z.literal('rtc.ice'),
    p: z.strictObject({
      ...peer,
      candidate: z.string().max(2048),
      sdpMid: z.string().max(256).nullable(),
      sdpMLineIndex: z.number().int().min(0).max(65535).nullable(),
    }),
  }),
  z.strictObject({ ...base, t: z.literal('ping'), p: z.strictObject({}) }),
])
export type Signalling = z.infer<typeof Signalling>

/** Decode one frame; peer authentication and request correlation are transport responsibilities. */
export function decodeSignallingFrame(wire: string): Signalling {
  return Signalling.parse(
    parseBoundedJson(wire, {
      maxBytes: 8192,
      maxDepth: 6,
      maxValues: 32,
      maxStringChars: 7000,
    }),
  )
}
