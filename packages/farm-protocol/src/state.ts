import { z } from 'zod'
import { ExtendedControlAction, MacroName } from './control-actions.ts'

export { firmwareUpdateAvailable } from './firmware.ts'

export const PrinterState = z
  .strictObject({
    macros: z.array(MacroName).max(50).optional(),
    controls: z
      .array(ExtendedControlAction)
      .max(ExtendedControlAction.options.length)
      .refine((actions) => new Set(actions).size === actions.length)
      .optional(),
    identity: z
      .strictObject({
        vendor: z.string().min(1).max(255).optional(),
        model: z.string().min(1).max(1024).optional(),
        firmware: z.string().min(1).max(1024).optional(),
      })
      .optional(),
    firmware: z
      .strictObject({
        current: z.string().min(1).max(64).optional(),
        latest: z.string().min(1).max(64).optional(),
        updateAvailable: z.boolean().optional(),
        components: z
          .array(
            z.strictObject({
              name: z.string().min(1).max(64),
              current: z.string().min(1).max(64),
              latest: z.string().min(1).max(64).optional(),
            }),
          )
          .max(16)
          .optional(),
      })
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
    fans: z
      .strictObject({
        part: z.number().int().min(0).max(100).optional(),
        aux: z.number().int().min(0).max(100).optional(),
        chamber: z.number().int().min(0).max(100).optional(),
      })
      .optional(),
    light: z
      .strictObject({
        chamber: z.boolean().optional(),
      })
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
