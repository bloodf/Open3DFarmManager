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
