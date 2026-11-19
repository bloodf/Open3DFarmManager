import { z } from 'zod'
import { ExtendedControlAction, MacroName } from './control-actions.ts'

export const FilamentUsage = z.strictObject({
  tool: z.string().min(1).max(32),
  millimetres: z.number().finite().nonnegative().optional(),
  grams: z.number().finite().nonnegative().optional(),
})
export type FilamentUsage = z.infer<typeof FilamentUsage>

const LocalWebUiOrigin = z
  .string()
  .max(512)
  .refine((value) => {
    try {
      const url = new URL(value)
      return (
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        url.origin === value &&
        !url.username &&
        !url.password
      )
    } catch {
      return false
    }
  }, 'Expected a credential-free local web UI origin')

export { firmwareUpdateAvailable } from './firmware.ts'

const positive = z.number().finite().positive()
const MachineProfile = z.strictObject({
  model: z.string().trim().min(1).max(64).optional(),
  toolCount: z.number().int().min(1).max(17).optional(),
  nozzleDiameterMm: z
    .record(z.string().regex(/^(?:[0-9]|1[0-6])$/), positive)
    .optional(),
  bedSizeMm: z
    .strictObject({
      x: positive.optional(),
      y: positive.optional(),
      z: positive.optional(),
    })
    .optional(),
  maxHotendTemperatureCelsius: z
    .record(z.string().regex(/^(?:[0-9]|1[0-6])$/), positive)
    .optional(),
  maxBedTemperatureCelsius: positive.optional(),
  kinematics: z.string().trim().min(1).max(64).optional(),
})

export const PrinterState = z
  .strictObject({
    machine: MachineProfile.optional(),
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
    linkHealth: z
      .strictObject({
        state: z.enum(['connected', 'reconnecting', 'offline']),
        lastSuccessAt: z.number().int().nonnegative().nullable(),
        p50Ms: z.number().finite().nonnegative().nullable(),
        p95Ms: z.number().finite().nonnegative().nullable(),
        reconnects: z.number().int().nonnegative(),
        lastErrorCode: z
          .string()
          .regex(/^[a-zA-Z0-9_.-]{1,64}$/)
          .nullable(),
      })
      .optional(),
    localWebUiOrigin: LocalWebUiOrigin.optional(),
    state: z.enum(['idle', 'printing', 'paused', 'error', 'offline']),
    statusReason: z.enum(['client-certificate-missing']).optional(),
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
          filamentDiameterMm: z.number().finite().positive().optional(),
          filamentDensityGramsPerCm3: z.number().finite().positive().optional(),
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
    lastJob: z
      .strictObject({
        outcome: z.enum(['completed', 'cancelled', 'failed']),
        filename: z.string().max(255).optional(),
        printDuration: z.number().finite().nonnegative().optional(),
        totalDuration: z.number().finite().nonnegative().optional(),
        filamentUsedMillimetres: z.number().finite().nonnegative().optional(),
        filamentUsage: z.array(FilamentUsage).max(17).optional(),
        endedAt: z.number().int().nonnegative(),
      })
      .optional(),
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
