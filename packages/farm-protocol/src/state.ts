import { z } from 'zod'

export const PrinterState = z
  .strictObject({
    printerKey: z.string().min(1).max(128),
    state: z.enum(['idle', 'printing', 'paused', 'error', 'offline']),
    progress: z.number().min(0).max(1).optional(),
    toolTemperatureCelsius: z.number().finite().optional(),
    bedTemperatureCelsius: z.number().finite().optional(),
    observedAt: z.number().int().nonnegative(),
  })
  .refine(
    (value) => value.state === 'offline' || value.progress !== undefined,
    {
      path: ['progress'],
      message: 'Online state requires progress',
    },
  )
export type PrinterState = z.infer<typeof PrinterState>
