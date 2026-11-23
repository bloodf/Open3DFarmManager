import { z } from 'zod'
import { PrinterState } from './state.ts'
import { SpoolInventory } from './inventory.ts'

import {
  DiscoveryPrinter,
  MAX_DISCOVERY_RESULTS,
} from './configuration-discovery.ts'

export const DiscoveryResults = z
  .array(
    DiscoveryPrinter.extend({
      model: DiscoveryPrinter.shape.model.unwrap().nullable(),
      name: DiscoveryPrinter.shape.name.unwrap().nullable(),
      port: DiscoveryPrinter.shape.port.unwrap().nullable(),
      firstSeen: z.number().int().nonnegative(),
      lastSeen: z.number().int().nonnegative(),
      adopted: z.boolean(),
    })
      .strict()
      .refine((value) => value.firstSeen <= value.lastSeen),
  )
  .max(MAX_DISCOVERY_RESULTS)
export type DiscoveryResults = z.infer<typeof DiscoveryResults>

export const MAX_HEARTBEAT_HEALTH_BYTES = 32 * 1024

const counter = z.number().int().nonnegative()
const measurement = z.number().nonnegative().nullable()
export const HeartbeatHealth = z
  .strictObject({
    connector: z.strictObject({
      version: z.string().min(1).max(64),
      uptimeMs: counter,
      queueBacklog: counter,
      storage: z.enum(['healthy', 'degraded']),
      rtcScope: z.enum(['loopback', 'lan', 'disabled']),
    }),
    cameraAssignments: z.array(z.uuid()).min(1).max(16).optional(),
    printers: z
      .array(
        z.strictObject({
          printerKey: PrinterState.shape.printerKey,
          state: z.enum(['connected', 'reconnecting', 'offline']),
          lastSuccessAt: counter.nullable(),
          p50Ms: measurement,
          p95Ms: measurement,
          reconnects: counter,
          lastErrorCode: z.string().max(64).nullable(),
        }),
      )
      .max(100),
  })
  .refine(
    (health) =>
      new TextEncoder().encode(JSON.stringify(health)).byteLength <=
      MAX_HEARTBEAT_HEALTH_BYTES,
    'Heartbeat health too large',
  )
export type HeartbeatHealth = z.infer<typeof HeartbeatHealth>

const envelope = {
  eventId: z.uuidv4(),
  queuedAt: z.number().int().nonnegative(),
}
/** A printer state transition observed by the Connector (including entry into `error`). */
export const PrinterTransition = z
  .strictObject({
    printerKey: PrinterState.shape.printerKey,
    from: PrinterState.shape.state,
    to: PrinterState.shape.state,
    reason: PrinterState.shape.statusReason,
    observedAt: PrinterState.shape.observedAt,
  })
  .refine((value) => value.from !== value.to, 'No-op transition')
/** `printer-state` is the periodic state snapshot; `printer-transition` is the event. */
export const TelemetryEvent = z.discriminatedUnion('kind', [
  z.strictObject({
    ...envelope,
    kind: z.literal('printer-state'),
    state: PrinterState,
  }),
  z.strictObject({
    ...envelope,
    kind: z.literal('printer-transition'),
    transition: PrinterTransition,
  }),
  z.strictObject({
    ...envelope,
    kind: z.literal('heartbeat'),
    health: HeartbeatHealth,
  }),
  z.strictObject({
    ...envelope,
    kind: z.literal('discovery'),
    discovery: DiscoveryResults,
  }),
  z.strictObject({
    ...envelope,
    kind: z.literal('inventory-snapshot'),
    inventory: SpoolInventory,
  }),
])
export const telemetryPrinterKey = (record: TelemetryEvent) =>
  record.kind === 'printer-state'
    ? record.state.printerKey
    : record.kind === 'printer-transition'
      ? record.transition.printerKey
      : null
/** Bounds a telemetry batch body must meet on both sides of the upload. */
export const TELEMETRY_BATCH_JSON_LIMITS = Object.freeze({
  maxBytes: 64 * 1024,
  maxDepth: 7,
  maxValues: 2000,
  // PrinterState.statusMessage permits 256 UTF-16 units; individual schemas
  // continue to enforce the tighter limits on all other fields.
  maxStringChars: 256,
})

export const TelemetryBatch = z
  .array(TelemetryEvent)
  .min(1)
  .max(100)
  .superRefine((records, ctx) => {
    if (
      new Set(records.map((record) => record.eventId)).size !== records.length
    )
      ctx.addIssue({ code: 'custom', message: 'Duplicate telemetry event' })
  })
export type TelemetryEvent = z.infer<typeof TelemetryEvent>
export type PrinterTransition = z.infer<typeof PrinterTransition>
