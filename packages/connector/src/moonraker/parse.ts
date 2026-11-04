import { z } from 'zod'
import { PrinterState } from '@open3dfarmmanager/farm-protocol'

const MAX_FRAME_BYTES = 256 * 1024
const nonnegative = z.number().finite().nonnegative()
const klippyState = z.enum([
  'ready',
  'startup',
  'shutdown',
  'error',
  'disconnected',
])
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
    value = JSON.parse(wire)
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
    ready: info.klippy_connected && info.klippy_state === 'ready',
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
  const { webhooks, print_stats, virtual_sdcard } = snapshot.status
  let state: PrinterState['state']
  if (webhooks.state === 'startup') state = 'offline'
  else if (webhooks.state !== 'ready') state = 'error'
  else {
    switch (print_stats.state) {
      case 'printing':
        state = 'printing'
        break
      case 'paused':
        state = 'paused'
        break
      case 'error':
        state = 'error'
        break
      default:
        state = 'idle'
    }
  }
  return {
    sourceEventtime: snapshot.eventtime,
    printer: PrinterState.parse({
      ...parsedContext.data,
      state,
      progress: virtual_sdcard.progress,
    }),
  }
}
