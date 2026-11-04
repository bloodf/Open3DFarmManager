import { z } from 'zod'
import { PrinterState } from './state.ts'

export const TelemetryEvent = z.strictObject({
  eventId: z.uuidv4(),
  queuedAt: z.number().int().nonnegative(),
  kind: z.literal('printer-state'),
  state: PrinterState,
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
