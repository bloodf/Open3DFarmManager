import { z } from 'zod'

export const PrinterState = z.strictObject({
  printerKey: z.string().min(1).max(128),
  state: z.enum(['idle', 'printing', 'paused', 'error', 'offline']),
  progress: z.number().min(0).max(1),
  observedAt: z.number().int().nonnegative(),
})
export type PrinterState = z.infer<typeof PrinterState>
