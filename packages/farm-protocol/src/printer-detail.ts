import { z } from 'zod'

/** Detail snapshots are intentionally chunk-sized for the existing RTC data channel. */
export const MAX_PRINTER_DETAIL_FRAME_BYTES = 64 * 1024
export const MAX_PRINTER_DETAIL_LIST = 256
export const MAX_PRINTER_DETAIL_TEXT = 4096

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const text = z.string().max(MAX_PRINTER_DETAIL_TEXT)
const finite = z.number().finite()
const nullableText = text.nullable()
const base = { v: z.literal(1), printer_key: id }

const vector3 = z.strictObject({ x: finite, y: finite, z: finite })
const heater = z.strictObject({
  name: id,
  temperature: finite,
  target: finite,
  power: finite,
})
const namedValue = z.strictObject({ name: id, value: finite })
const namedState = z.strictObject({
  name: id,
  value: z.union([text, finite, z.boolean()]),
})
const boundedStrings = z.array(text).max(MAX_PRINTER_DETAIL_LIST)
const objectJson = z.record(
  text,
  z.union([text, finite, z.boolean(), z.null()]),
)

export const PrinterDetailUpdate = z
  .strictObject({
    ...base,
    t: z.literal('detail.update'),
    seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    toolhead: z
      .strictObject({ position: vector3, homed_axes: boundedStrings })
      .optional(),
    heaters: z.array(heater).max(64),
    fans: z.array(namedValue).max(64),
    leds: z.array(namedState).max(64),
    output_pins: z.array(namedState).max(64),
    speed_factor: finite,
    flow_factor: finite,
    gcode_offsets: vector3,
    print_stats: z
      .strictObject({
        state: id,
        filename: text,
        total_duration: finite,
        print_duration: finite,
        filament_used: finite,
      })
      .nullable(),
    virtual_sdcard: z
      .strictObject({ progress: finite, is_active: z.boolean() })
      .nullable(),
    display_status: z
      .strictObject({
        message: nullableText,
        progress: finite,
        layers: z.strictObject({
          current: finite.nullable(),
          total: finite.nullable(),
        }),
      })
      .nullable(),
    exclude_object: z
      .strictObject({
        objects: z
          .array(
            z.strictObject({ name: text, polygon: z.array(vector3).max(4096) }),
          )
          .max(MAX_PRINTER_DETAIL_LIST),
        excluded_objects: boundedStrings,
      })
      .nullable(),
    bed_mesh: z
      .strictObject({
        profile_name: nullableText,
        mesh_min: vector3.nullable(),
        mesh_max: vector3.nullable(),
        x_count: z.number().int().nonnegative().max(1024),
        y_count: z.number().int().nonnegative().max(1024),
        points: z.array(z.array(finite).max(1024)).max(1024),
      })
      .nullable(),
    idle_timeout: z
      .strictObject({ state: id, time_remaining: finite })
      .nullable(),
    klippy: z.strictObject({ state: id, message: nullableText }),
    host_stats: z.record(text, z.union([finite, text, z.boolean(), z.null()])),
  })
  .superRefine((value, ctx) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength
    if (bytes > MAX_PRINTER_DETAIL_FRAME_BYTES)
      ctx.addIssue({
        code: 'custom',
        message: 'detail update must be chunked to RTC frame limit',
      })
  })
export type PrinterDetailUpdate = z.infer<typeof PrinterDetailUpdate>

export const PrinterDetailCapability = z.strictObject({
  ...base,
  t: z.literal('detail.capability'),
  areas: z
    .array(
      z.enum([
        'toolhead',
        'heaters',
        'fans',
        'lights',
        'pins',
        'job',
        'objects',
        'bed_mesh',
        'idle_timeout',
        'host',
        'files',
        'history',
        'config',
        'queue',
        'power',
        'timelapse',
        'updates',
        'temperature_store',
      ]),
    )
    .max(32),
})

export const PrinterDetailGcodeResponse = z.strictObject({
  ...base,
  t: z.literal('detail.gcode_response'),
  lines: z.array(text).min(1).max(128),
})
export const PrinterDetailSubscription = z.discriminatedUnion('t', [
  z.strictObject({ ...base, t: z.literal('detail.subscribe') }),
  z.strictObject({ ...base, t: z.literal('detail.unsubscribe') }),
])

export const PrinterDetailQueryKind = z.enum([
  'files',
  'history',
  'totals',
  'config_files',
  'config_read',
  'job_queue',
  'power_devices',
  'timelapse',
  'update_status',
  'temperature_store',
])
export const PrinterDetailQueryRequest = z.strictObject({
  ...base,
  t: z.literal('detail.query'),
  request_id: id,
  kind: PrinterDetailQueryKind,
  offset: z.number().int().min(0).max(10000).default(0),
  limit: z.number().int().min(1).max(100),
  path: text.optional(),
})
const queryItem = z.record(text, z.union([text, finite, z.boolean(), z.null()]))
export const PrinterDetailQueryResponse = z.discriminatedUnion('ok', [
  z.strictObject({
    ...base,
    t: z.literal('detail.query_result'),
    request_id: id,
    kind: PrinterDetailQueryKind,
    ok: z.literal(true),
    items: z.array(queryItem).max(100),
    next_offset: z.number().int().min(0).max(10000).nullable(),
  }),
  z.strictObject({
    ...base,
    t: z.literal('detail.query_result'),
    request_id: id,
    kind: PrinterDetailQueryKind,
    ok: z.literal(false),
    reason: z.enum(['unsupported', 'offline', 'busy', 'not_found', 'invalid']),
  }),
])

export const PrinterDetailFrame = z
  .union([
    PrinterDetailSubscription,
    PrinterDetailUpdate,
    PrinterDetailCapability,
    PrinterDetailGcodeResponse,
    PrinterDetailQueryRequest,
    PrinterDetailQueryResponse,
  ])
  .superRefine((value, ctx) => {
    if (
      new TextEncoder().encode(JSON.stringify(value)).byteLength >
      MAX_PRINTER_DETAIL_FRAME_BYTES
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'printer detail frame exceeds RTC limit; split into chunks',
      })
    }
  })
export type PrinterDetailFrame = z.infer<typeof PrinterDetailFrame>

/** Session-local ownership guard. A page leaving must unsubscribe its printer key. */
export class PrinterDetailSubscriptions {
  readonly #printers = new Set<string>()
  subscribe(printerKey: string): boolean {
    const key = id.parse(printerKey)
    if (this.#printers.has(key)) return false
    this.#printers.add(key)
    return true
  }
  unsubscribe(printerKey: string): boolean {
    return this.#printers.delete(id.parse(printerKey))
  }
  has(printerKey: string): boolean {
    return this.#printers.has(id.parse(printerKey))
  }
}
