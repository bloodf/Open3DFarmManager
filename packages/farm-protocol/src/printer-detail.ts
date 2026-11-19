// SPDX-License-Identifier: MIT
import { PrinterState } from './state.ts'
import { z } from 'zod'
import { parseBoundedJson } from './json.ts'
import { RtcAssignmentRef } from './rtc-assignment-set.ts'
import { MAX_RTC_PROOF_WIRE_BYTES } from './rtc-session-binding.ts'

const string = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !/[\uD800-\uDFFF]/u.test(value))
const name = string(128).refine((value) => value.length > 0)
const path = string(512).refine((value) => value.length > 0)
const message = string(2048)
const number = z.number().finite()
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const fraction = number.min(0).max(1)
const xyz = z.tuple([number, number, number])
const axis = z.enum(['x', 'y', 'z'])
const base = { v: z.literal(1), printerKey: RtcAssignmentRef.shape.printerKey }
const named = <T extends z.ZodRawShape>(shape: T) =>
  z.array(z.strictObject({ ...shape, name })).max(64)

export const PrinterDetailCapability = z.enum([
  'motion',
  'heaters',
  'fans',
  'lights',
  'outputs',
  'speed',
  'flow',
  'offsets',
  'files',
  'job',
  'exclude-object',
  'bed-mesh',
  'job-queue',
  'power',
  'timelapse',
  'updates',
  'system',
  'console',
  'webcams',
  'materials',
])
const capabilities = z
  .array(PrinterDetailCapability)
  .max(20)
  .refine((items) => new Set(items).size === items.length)

export const PrinterDetailSubscribe = z.strictObject({
  ...base,
  t: z.literal('detail.subscribe'),
})
export const PrinterDetailUnsubscribe = z.strictObject({
  ...base,
  t: z.literal('detail.unsubscribe'),
})
export const PrinterDetailUpdate = z.strictObject({
  ...base,
  t: z.literal('detail.update'),
  seq: count,
  vendor: z.enum(['anycubic', 'kobra-x']).optional(),
  capabilities,
  detail: z
    .strictObject({
      toolhead: z.strictObject({
        position: z.tuple([number, number, number, number]),
        homedAxes: z
          .array(axis)
          .max(3)
          .refine((axes) => new Set(axes).size === axes.length),
      }),
      heaters: named({
        temperature: number,
        target: number.optional(),
        power: fraction.optional(),
      }),
      fans: named({ speed: fraction, rpm: count.optional() }),
      lights: named({
        red: fraction,
        green: fraction,
        blue: fraction,
        white: fraction.optional(),
      }),
      outputs: named({ value: number }),
      webcams: named({
        uid: name.nullable(),
        enabled: z.boolean(),
        rotation: z.union([
          z.literal(0),
          z.literal(90),
          z.literal(180),
          z.literal(270),
        ]),
        flipHorizontal: z.boolean(),
        flipVertical: z.boolean(),
      }),
      speedFactor: number.nonnegative(),
      flowFactor: number.nonnegative(),
      offsets: xyz,
      print: z.strictObject({
        file: path.optional(),
        state: name,
        message,
        elapsedSeconds: number.nonnegative().optional(),
        progress: fraction.optional(),
        currentLayer: count.optional(),
        totalLayers: count.optional(),
      }),
      materials: PrinterState.shape.materials,
      virtualFile: z.strictObject({
        active: z.boolean(),
        progress: fraction,
        position: count,
        size: count,
      }),
      display: z.strictObject({ message, progress: fraction }),
      objects: z.strictObject({
        names: z.array(name).max(256),
        excluded: z.array(name).max(256),
        current: name.nullable(),
      }),
      bedMesh: z.strictObject({
        profile: name.nullable(),
        min: z.tuple([number, number]),
        max: z.tuple([number, number]),
        rows: z
          .array(z.array(number).min(1).max(64))
          .min(1)
          .max(64)
          .refine((rows) =>
            rows.every((row) => row.length === rows[0]?.length),
          ),
      }),
      idle: z.strictObject({
        state: name,
        printingSeconds: number.nonnegative(),
      }),
      firmware: z.strictObject({ state: name, message }),
      updates: named({ installed: string(128), available: string(128) }),
      host: z.strictObject({
        temperatureC: number.optional(),
        cpuLoad: number.nonnegative().optional(),
        memoryBytes: count.optional(),
        cpuSeconds: number.nonnegative().optional(),
        uptimeSeconds: number.nonnegative().optional(),
      }),
    })
    .partial(),
})
export const PrinterDetailGcodeResponse = z.strictObject({
  ...base,
  t: z.literal('detail.gcode_response'),
  seq: count,
  lines: z.array(message).min(1).max(64),
})

const queryResults = {
  files: z
    .array(z.strictObject({ path, bytes: count, modifiedAtMs: count }))
    .max(256),
  history: z
    .array(
      z.strictObject({
        id: name,
        file: path,
        state: name,
        startedAtMs: count,
        durationSeconds: number.nonnegative(),
      }),
    )
    .max(256),
  totals: z.strictObject({
    jobs: count,
    printSeconds: number.nonnegative(),
    filamentMm: number.nonnegative(),
    longestJobSeconds: number.nonnegative().optional(),
  }),
  'config-files': z.array(path).max(256),
  'config-read': z.strictObject({ path, text: string(65_536) }),
  'job-queue': z.strictObject({
    state: name,
    jobs: z.array(z.strictObject({ id: name, file: path })).max(256),
  }),
  'power-devices': named({ on: z.boolean() }),
  timelapse: z.strictObject({
    enabled: z.boolean(),
    rendering: z.boolean(),
    files: z.array(path).max(256),
  }),
  'update-status': named({ installed: name, available: name.optional() }),
  'temperature-store': named({
    samples: z
      .array(
        z.strictObject({
          atMs: count,
          temperature: number,
          target: number.optional(),
          power: fraction.optional(),
        }),
      )
      .max(256),
  }),
}
export const PrinterDetailQueryKind = z.enum(
  Object.keys(queryResults) as (keyof typeof queryResults)[],
)
const query = { ...base, requestId: name }

export const PrinterDetailQueryRequest = z.union([
  z.strictObject({
    ...query,
    t: z.literal('query.request'),
    kind: z.literal('config-read'),
    path,
  }),
  z.strictObject({
    ...query,
    t: z.literal('query.request'),
    kind: PrinterDetailQueryKind.exclude(['config-read']),
  }),
])
export const PrinterDetailQueryResponse = z.union([
  ...Object.entries(queryResults).map(([kind, data]) =>
    z.strictObject({
      ...query,
      t: z.literal('query.response'),
      kind: z.literal(kind),
      data,
    }),
  ),
  z.strictObject({
    ...query,
    t: z.literal('query.response'),
    kind: PrinterDetailQueryKind,
    error: z.enum(['unsupported', 'unavailable', 'not-found', 'too-large']),
  }),
])

const payload = z.union([
  PrinterDetailUpdate,
  PrinterDetailGcodeResponse,
  PrinterDetailQueryResponse,
])
const maxPayloadBytes = 1_048_576
const chunkChars = 1024
const maxChunks = Math.ceil(maxPayloadBytes / (chunkChars - 1))
export const MAX_PRINTER_DETAIL_WIRE_BYTES = MAX_RTC_PROOF_WIRE_BYTES
const chunk = z
  .strictObject({
    ...base,
    t: z.literal('detail.chunk'),
    transferId: name,
    index: count,
    total: count.min(2).max(maxChunks),
    text: string(chunkChars).refine((value) => value.length > 0),
  })
  .refine(
    ({ index, total, text }) =>
      index < total && (index === total - 1 || text.length >= chunkChars - 1),
  )
export const PrinterDetailFrame = z.union([
  PrinterDetailSubscribe,
  PrinterDetailUnsubscribe,
  PrinterDetailQueryRequest,
  payload,
  chunk,
])
const byteLength = (wire: string) => new TextEncoder().encode(wire).byteLength

export function decodePrinterDetailFrame(wire: string) {
  return PrinterDetailFrame.parse(
    parseBoundedJson(wire, {
      maxBytes: MAX_PRINTER_DETAIL_WIRE_BYTES,
    }),
  )
}

/** A transfer ID is unique among in-flight messages on the authenticated session. */
export function encodePrinterDetailFrames(
  input: unknown,
  transferId: string,
): string[] {
  const frame = PrinterDetailFrame.parse(input)
  const wire = JSON.stringify(frame)
  if (byteLength(wire) <= MAX_PRINTER_DETAIL_WIRE_BYTES) return [wire]
  const { printerKey } = payload.parse(frame)
  if (byteLength(wire) > maxPayloadBytes)
    throw new RangeError('Printer detail payload too large')
  const parts: string[] = []
  for (let start = 0; start < wire.length;) {
    let end = start + chunkChars
    // Keep surrogate pairs together so each chunk is valid Unicode on its own.
    const next = wire.charCodeAt(end)
    if (next >= 0xdc00 && next <= 0xdfff) end--
    parts.push(wire.slice(start, end))
    start = end
  }
  return parts.map((text, index) =>
    JSON.stringify(
      chunk.parse({
        v: 1,
        t: 'detail.chunk',
        printerKey,
        transferId,
        index,
        total: parts.length,
        text,
      }),
    ),
  )
}

/** Invoke with one ordered transfer from one session. */
export function assemblePrinterDetailFrames(wires: readonly string[]) {
  if (wires.length < 2 || wires.length > maxChunks) {
    throw new RangeError('Invalid printer detail transfer length')
  }
  const parts = wires.map((wire) => chunk.parse(decodePrinterDetailFrame(wire)))
  const first = parts[0]!
  if (
    parts.some(
      (part, index) =>
        part.index !== index ||
        part.total !== parts.length ||
        part.transferId !== first.transferId ||
        part.printerKey !== first.printerKey,
    )
  )
    throw new Error('Invalid printer detail chunk sequence')
  const frame = payload.parse(
    parseBoundedJson(parts.map((part) => part.text).join(''), {
      maxBytes: maxPayloadBytes,
      maxValues: 100_000,
      maxStringChars: 65_536,
    }),
  )
  if (frame.printerKey !== first.printerKey)
    throw new Error('Printer detail transfer identity mismatch')
  return frame
}

/** Create one registry per admitted read-only session, using its assignment set. */
export function createPrinterDetailSubscriptions(
  isAssigned: (printerKey: string) => boolean,
  start: (printerKey: string) => () => void,
) {
  const active = new Map<string, () => void>()
  let closed = false
  return {
    receive(input: unknown) {
      const frame = z
        .union([PrinterDetailSubscribe, PrinterDetailUnsubscribe])
        .parse(input)
      const { printerKey } = frame
      if (closed) return false
      if (frame.t === 'detail.unsubscribe') {
        const stop = active.get(printerKey)
        active.delete(printerKey)
        stop?.()
        return true
      }
      if (!isAssigned(printerKey)) return false
      if (!active.has(printerKey)) active.set(printerKey, start(printerKey))
      return true
    },
    close() {
      closed = true
      const stops = [...active.values()]
      active.clear()
      const errors: unknown[] = []
      for (const stop of stops) {
        try {
          stop()
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length)
        throw new AggregateError(
          errors,
          'Printer detail subscription cleanup failed',
        )
    },
  }
}
