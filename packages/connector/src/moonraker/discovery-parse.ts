import { z } from 'zod'

// Strict, bounded projections of Moonraker discovery results. Unknown upstream
// fields are ignored; malformed entries are dropped, never repaired.
export const MAX_TOOLS = 16
export const MAX_WEBCAMS = 8
const MAX_URL_CHARS = 2048
const name = z.string().min(1).max(128)
const temp = z.number().finite().min(-273.15).max(2000)

export type MoonrakerIdentity = Readonly<{ connectionId: number }>
export function parseIdentifyResult(result: unknown): MoonrakerIdentity {
  const parsed = z
    .object({ connection_id: z.number().int().nonnegative() })
    .parse(result)
  return { connectionId: parsed.connection_id }
}

export type MoonrakerServerInfo = Readonly<{
  klippyConnected: boolean
  klippyState: 'ready' | 'startup' | 'shutdown' | 'error' | 'disconnected'
  ready: boolean
  moonrakerVersion: string | null
  apiVersion: readonly [number, number, number] | null
}>
const Version = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
])
export function parseServerInfoResult(result: unknown): MoonrakerServerInfo {
  const info = z
    .object({
      klippy_connected: z.boolean(),
      klippy_state: z.enum([
        'ready',
        'startup',
        'shutdown',
        'error',
        'disconnected',
      ]),
      moonraker_version: z.string().max(128).optional().catch(undefined),
      api_version: Version.optional().catch(undefined),
    })
    .parse(result)
  return {
    klippyConnected: info.klippy_connected,
    klippyState: info.klippy_state,
    ready: info.klippy_connected && info.klippy_state === 'ready',
    moonrakerVersion: info.moonraker_version ?? null,
    apiVersion: info.api_version ?? null,
  }
}

/** Klipper extruder objects: `extruder`, `extruder1` ... `extruderN`. Tool index = N. */
export function extruderIndex(object: string): number | undefined {
  const match = /^extruder(0|[1-9][0-9]{0,2})?$/.exec(object)
  if (!match) return undefined
  return match[1] === undefined ? 0 : Number(match[1])
}

export function selectToolObjects(list: unknown): string[] {
  const parsed = z
    .object({ objects: z.array(z.unknown()).max(1024) })
    .safeParse(list)
  if (!parsed.success) throw new TypeError('Invalid object list')
  const found = new Map<number, string>()
  for (const object of parsed.data.objects) {
    if (typeof object !== 'string') continue
    const index = extruderIndex(object)
    if (index !== undefined) found.set(index, object)
  }
  return [...found.entries()]
    .sort(([a], [b]) => a - b)
    .slice(0, MAX_TOOLS)
    .map(([, object]) => object)
}

export type MoonrakerTool = Readonly<{
  index: number
  object: string
  active: boolean
  celsius: number | null
  targetCelsius: number | null
}>
export type MoonrakerToolStatus = Readonly<{
  activeObject: string | null
  tools: readonly MoonrakerTool[]
}>
/** `status` is the `status` member of a printer.objects.query result. */
export function parseToolStatus(status: unknown): MoonrakerToolStatus {
  const parsed = z
    .object({
      toolhead: z
        .object({ extruder: name.optional().catch(undefined) })
        .optional()
        .catch(undefined),
    })
    .passthrough()
    .safeParse(status)
  if (!parsed.success) throw new TypeError('Invalid Moonraker status')
  const record = status as Record<string, unknown>
  const activeObject = parsed.data.toolhead?.extruder ?? null
  const tools: MoonrakerTool[] = []
  for (const object of Object.keys(record)) {
    const index = extruderIndex(object)
    if (index === undefined) continue
    const sensor = z
      .object({
        temperature: temp.optional().catch(undefined),
        target: temp.optional().catch(undefined),
      })
      .safeParse(record[object])
    if (!sensor.success) continue
    tools.push({
      index,
      object,
      active: object === activeObject,
      celsius: sensor.data.temperature ?? null,
      targetCelsius: sensor.data.target ?? null,
    })
  }
  tools.sort((a, b) => a.index - b.index)
  return { activeObject, tools: tools.slice(0, MAX_TOOLS) }
}

export type MoonrakerWebcam = Readonly<{
  uid: string | null
  name: string
  enabled: boolean
  service: string
  /** Same-origin absolute URLs only; null when absent, foreign or malformed. */
  streamUrl: string | null
  snapshotUrl: string | null
  targetFps: number | null
  rotation: 0 | 90 | 180 | 270
  flipHorizontal: boolean
  flipVertical: boolean
}>

function sameOriginUrl(value: unknown, origin: string): string | null {
  if (typeof value !== 'string' || value.length > MAX_URL_CHARS) return null
  if (value === '' || /[\u0000- \u007F\\]/u.test(value)) return null
  try {
    const url = new URL(value, origin)
    if (url.origin !== new URL(origin).origin || url.username || url.password)
      return null
    return url.href
  } catch {
    return null
  }
}

const Webcam = z.object({
  uid: z.string().max(128).optional().catch(undefined),
  name,
  enabled: z.boolean().optional().catch(undefined),
  service: z.string().max(64).optional().catch(undefined),
  stream_url: z.unknown().optional(),
  snapshot_url: z.unknown().optional(),
  target_fps: z.number().int().min(1).max(240).optional().catch(undefined),
  rotation: z
    .union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])
    .optional()
    .catch(undefined),
  flip_horizontal: z.boolean().optional().catch(undefined),
  flip_vertical: z.boolean().optional().catch(undefined),
})

export function parseWebcamsResult(
  result: unknown,
  origin: string,
): readonly MoonrakerWebcam[] {
  const list = z
    .object({ webcams: z.array(z.unknown()).max(256) })
    .parse(result)
  const out: MoonrakerWebcam[] = []
  for (const item of list.webcams) {
    if (out.length >= MAX_WEBCAMS) break
    const cam = Webcam.safeParse(item)
    if (!cam.success) continue
    const d = cam.data
    out.push({
      uid: d.uid ?? null,
      name: d.name,
      enabled: d.enabled ?? true,
      service: d.service ?? 'unknown',
      streamUrl: sameOriginUrl(d.stream_url, origin),
      snapshotUrl: sameOriginUrl(d.snapshot_url, origin),
      targetFps: d.target_fps ?? null,
      rotation: d.rotation ?? 0,
      flipHorizontal: d.flip_horizontal ?? false,
      flipVertical: d.flip_vertical ?? false,
    })
  }
  return out
}
