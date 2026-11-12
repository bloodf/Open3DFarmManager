import { z } from 'zod'
import { PrinterState } from './state.ts'

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
])
export const telemetryPrinterKey = (record: TelemetryEvent) =>
  record.kind === 'printer-state'
    ? record.state.printerKey
    : record.transition.printerKey
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
