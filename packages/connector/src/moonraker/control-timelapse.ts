import { DriverRefusalError } from '../control/driver-refusal.ts'
import { z } from 'zod'
import { TimelapseArguments } from '../../../farm-protocol/src/control-actions.ts'

/**
 * Moonraker adapter for the signed `timelapse` action. Timelapse is a
 * Moonraker plugin component, so support is detected from `server.info` and
 * carried next to the object list as one marker entry. Without the marker the
 * action is neither advertised nor built. Requests are built only from
 * validated names; refusals are decided from one read taken just before the
 * single send, and an uncertain send is never repeated.
 */

/** Marker detection appends to the object list when the plugin is loaded. */
export const TIMELAPSE_COMPONENT_MARKER = 'moonraker_component timelapse'
/** Moonraker file root that holds rendered videos. */
export const TIMELAPSE_ROOT = 'timelapse'
/** Largest listing the Connector reads before it refuses. */
export const TIMELAPSE_MAX_FILES = 256

export type TimelapseRefusalReason =
  'state' | 'unsupported-action' | 'invalid-command'

/** Thrown before any write; the dispatcher reports a not-sent result. */
export class TimelapseRefused extends DriverRefusalError {
  constructor(refusal: TimelapseRefusalReason) {
    super(refusal, `Timelapse operation refused: ${refusal}`)
    this.name = 'TimelapseRefused'
  }
}

/** True only when the printer's Moonraker lists the timelapse plugin. */
export const timelapseSupported = (objects: readonly string[] | undefined) =>
  !!objects?.includes(TIMELAPSE_COMPONENT_MARKER)

const ServerInfo = z.object({ components: z.array(z.string()).max(512) })

/** Marker entries for a `server.info` reply; a malformed reply adds none. */
export function timelapseMarkers(result: unknown): readonly string[] {
  const info = ServerInfo.safeParse(result)
  return info.success && info.data.components.includes('timelapse')
    ? [TIMELAPSE_COMPONENT_MARKER]
    : []
}

export type TimelapseCall = Readonly<{
  method: string
  params?: Record<string, unknown>
}>

/** Validates the arguments and maps them to the one JSON-RPC call. */
export function parseTimelapseOp(args: unknown): {
  op: TimelapseArguments
  call: TimelapseCall
} {
  const parsed = TimelapseArguments.safeParse(args)
  if (!parsed.success) throw new TimelapseRefused('invalid-command')
  const op = parsed.data
  return op.op === 'render'
    ? { op, call: { method: 'server.timelapse.render' } }
    : {
        op,
        call: {
          method: 'server.files.delete_file',
          params: { path: `${TIMELAPSE_ROOT}/${op.file}` },
        },
      }
}

const read = (id: number, method: string, params?: Record<string, unknown>) =>
  JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    ...(params ? { params } : {}),
  })

/** Read-only query the operation depends on: render state or the video list. */
export const timelapseStatusWire = (id: number, op: TimelapseArguments) =>
  op.op === 'render'
    ? read(id, 'server.timelapse.get_settings')
    : read(id, 'server.files.list', { root: TIMELAPSE_ROOT })

const Settings = z.object({ rendering: z.boolean().optional() })
const Listing = z
  .array(z.object({ path: z.string().min(1).max(512) }))
  .max(TIMELAPSE_MAX_FILES)

export type TimelapseStatus = Readonly<
  { rendering: boolean } | { files: ReadonlySet<string> }
>

/** Anything but a well-formed reply is "unknown state", which refuses. */
export function parseTimelapseStatus(
  op: TimelapseArguments,
  result: unknown,
): TimelapseStatus {
  if (op.op === 'render') {
    const settings = Settings.safeParse(result)
    if (!settings.success) throw new TimelapseRefused('state')
    return Object.freeze({ rendering: settings.data.rendering === true })
  }
  const listing = Listing.safeParse(result)
  if (!listing.success) throw new TimelapseRefused('state')
  return Object.freeze({
    files: new Set(listing.data.map(({ path }) => path)),
  })
}

/**
 * Connector-side refusal from the live state: a render never starts while
 * another one runs, and delete names only a video that exists right now.
 */
export function refuseTimelapseOp(
  op: TimelapseArguments,
  status: TimelapseStatus | undefined,
): void {
  if (!status) throw new TimelapseRefused('state')
  if (op.op === 'render') {
    if (!('rendering' in status) || status.rendering)
      throw new TimelapseRefused('state')
    return
  }
  if (!('files' in status) || !status.files.has(op.file))
    throw new TimelapseRefused('state')
}

const RenderReply = z.object({ status: z.enum(['success', 'started']) })
const DeleteReply = z.object({ action: z.literal('delete_file') })

/** A reply that is not the documented acknowledgement is not one. */
export function timelapseReplyAccepted(
  op: TimelapseArguments,
  result: unknown,
): boolean {
  return (
    result === 'ok' ||
    (op.op === 'render' ? RenderReply : DeleteReply).safeParse(result).success
  )
}
