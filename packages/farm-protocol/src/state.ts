import { z } from 'zod'
import { ControlAction } from './control-actions.ts'

export const PrinterState = z
  .strictObject({
    controls: z
      .array(ControlAction)
      .max(3)
      .refine((actions) => new Set(actions).size === actions.length)
      .optional(),
    printerKey: z.string().min(1).max(128),
    state: z.enum(['idle', 'printing', 'paused', 'error', 'offline']),
    progress: z.number().min(0).max(1).optional(),
    materials: z
      .array(
        z.strictObject({
          slot: z.string().max(32),
          materialType: z.string().max(64).optional(),
          colorHex: z
            .string()
            .regex(/^[0-9A-F]{8}$/)
            .optional(),
          remainingPercent: z.number().min(0).max(100).optional(),
          active: z.boolean().optional(),
        }),
      )
      .max(17)
      .optional(),
    filename: z.string().max(255).optional(),
    printDuration: z.number().finite().nonnegative().optional(),
    totalDuration: z.number().finite().nonnegative().optional(),
    currentLayer: z.number().int().nonnegative().optional(),
    totalLayer: z.number().int().nonnegative().optional(),
    estimatedRemainingSeconds: z.number().finite().nonnegative().optional(),
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
