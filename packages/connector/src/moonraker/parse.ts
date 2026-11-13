import { z } from 'zod'
import { normalizeMoonrakerSnapshot } from './normalize.ts'
import {
  PrinterState,
  parseBoundedJson,
} from '@open3dfarmmanager/farm-protocol'

const MAX_FRAME_BYTES = 256 * 1024
const nonnegative = z.number().finite().nonnegative()
export const klippyState = z.enum([
  'ready',
  'startup',
  'shutdown',
  'error',
  'disconnected',
])
/** Single readiness rule: Klippy connected and in the ready state. */
export function klippyReady(
  connected: boolean,
  state: z.infer<typeof klippyState>,
): boolean {
  return connected && state === 'ready'
}
const ServerInfo = z.object({
  klippy_connected: z.boolean(),
  klippy_state: klippyState,
})
const Status = z.object({
  webhooks: z.object({
    state: z.enum(['ready', 'startup', 'shutdown', 'error']),
  }),
  print_stats: z.object({
    state: z.enum([
      'standby',
      'printing',
      'paused',
      'error',
      'complete',
      'cancelled',
    ]),
  }),
  virtual_sdcard: z.object({ progress: z.number().finite().min(0).max(1) }),
})
const Snapshot = z.object({ eventtime: nonnegative, status: Status })
export type ValidatedMoonrakerSnapshot = z.infer<typeof Snapshot>
const Context = z.strictObject({
  printerKey: z.string().min(1).max(128),
  observedAt: z.number().int().nonnegative(),
})
export type ObservationContext = z.infer<typeof Context>
export type MoonrakerReadErrorCode =
  | 'invalid-frame'
  | 'frame-too-large'
  | 'remote-error'
  | 'invalid-result'
  | 'invalid-context'
export class MoonrakerReadError extends Error {
  readonly code: MoonrakerReadErrorCode
  constructor(code: MoonrakerReadErrorCode) {
    super(`Moonraker response rejected: ${code}`)
    this.name = 'MoonrakerReadError'
    this.code = code
  }
}

function result(wire: string): unknown {
  if (typeof wire !== 'string') throw new MoonrakerReadError('invalid-frame')
  if (Buffer.byteLength(wire, 'utf8') > MAX_FRAME_BYTES)
    throw new MoonrakerReadError('frame-too-large')
  let value: unknown
  try {
    value = parseBoundedJson(wire, {
      maxBytes: MAX_FRAME_BYTES,
      maxDepth: 16,
      maxValues: 8192,
      maxStringChars: 16384,
    })
  } catch {
    throw new MoonrakerReadError('invalid-frame')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new MoonrakerReadError('invalid-frame')
  if (Object.hasOwn(value, 'error'))
    throw new MoonrakerReadError('remote-error')
  // HTTP responses only. JSON-RPC requires request-ID matching in a separate transport.
  if (Object.keys(value).length !== 1 || !Object.hasOwn(value, 'result'))
    throw new MoonrakerReadError('invalid-frame')
  return (value as { result: unknown }).result
}
function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new MoonrakerReadError('invalid-result')
  return parsed.data
}

export function parseMoonrakerServerInfo(wire: string): {
  connected: boolean
  state: z.infer<typeof klippyState>
  ready: boolean
} {
  const info = validate(ServerInfo, result(wire))
  return {
    connected: info.klippy_connected,
    state: info.klippy_state,
    ready: klippyReady(info.klippy_connected, info.klippy_state),
  }
}

/** Complete HTTP object-query response only. No requests, commands or incremental merging. */
export function parseMoonrakerSnapshot(
  wire: string,
  input: ObservationContext,
): { sourceEventtime: number; printer: PrinterState } {
  const parsedContext = Context.safeParse(input)
  if (!parsedContext.success) throw new MoonrakerReadError('invalid-context')
  const snapshot = validate(Snapshot, result(wire))
  return normalizeMoonrakerSnapshot(snapshot, parsedContext.data)
}
