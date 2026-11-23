import { z } from 'zod'
import {
  ExtendedControlAction,
  MACRO_PARAM_MAX_KEYS,
  MacroName,
  MacroParamName,
  MacroParamValue,
} from './control-actions.ts'
import { MachineProfile } from './machine-profile.ts'
import {
  isWellFormedJsonString,
  PRINTER_STRING_MAX_UNITS,
} from './string-bounds.ts'

export const PRINTER_HMS_MAX_ENTRIES = 64

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

function printerStateSchema(legacy: boolean) {
  const text = (max: number, min = 0) => {
    const schema = z.string().min(min).max(max)
    return legacy
      ? schema
      : schema.refine(
          (value) =>
            value.length <= PRINTER_STRING_MAX_UNITS &&
            isWellFormedJsonString(value),
          'Expected well-formed Unicode within the telemetry string limit',
        )
  }
  const localWebUiOrigin = legacy
    ? LocalWebUiOrigin
    : LocalWebUiOrigin.refine(
        (value) => value.length <= PRINTER_STRING_MAX_UNITS,
        'Local web UI origin exceeds the telemetry string limit',
      )
  const machine = legacy
    ? MachineProfile
    : MachineProfile.refine(
        (profile) =>
          profile.model === undefined || isWellFormedJsonString(profile.model),
        { path: ['model'], message: 'Invalid Unicode' },
      )
  const macroParamValue = legacy
    ? MacroParamValue
    : MacroParamValue.refine(isWellFormedJsonString, 'Invalid Unicode')
  const filamentUsage = legacy
    ? FilamentUsage
    : FilamentUsage.extend({ tool: text(32, 1) })

  return z
    .strictObject({
      macros: z.array(MacroName).max(50).optional(),
      /** Parameters each macro reads (`params.X`), with a literal default if any. */
      macroParams: z
        .record(
          MacroName,
          z
            .array(
              z.strictObject({
                name: MacroParamName,
                default: macroParamValue.optional(),
              }),
            )
            .max(MACRO_PARAM_MAX_KEYS),
        )
        .refine((value) => Object.keys(value).length <= 50)
        .optional(),
      controls: z
        .array(ExtendedControlAction)
        .max(ExtendedControlAction.options.length)
        .refine((actions) => new Set(actions).size === actions.length)
        .optional(),
      identity: z
        .strictObject({
          vendor: text(255, 1).optional(),
          model: text(1024, 1).optional(),
          firmware: text(1024, 1).optional(),
        })
        .optional(),
      /** Sent on change only; never part of the live status snapshot. */
      machine: machine.optional(),
      firmware: z
        .strictObject({
          current: text(64, 1).optional(),
          latest: text(64, 1).optional(),
          updateAvailable: z.boolean().optional(),
          components: z
            .array(
              z.strictObject({
                name: text(64, 1),
                current: text(64, 1),
                latest: text(64, 1).optional(),
              }),
            )
            .max(16)
            .optional(),
        })
        .optional(),
      printerKey: text(PRINTER_STRING_MAX_UNITS, 1),
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
      localWebUiOrigin: localWebUiOrigin.optional(),
      state: z.enum([
        'idle',
        'printing',
        'paused',
        'error',
        'offline',
        'unknown',
      ]),
      preformStatus: text(256, 1).optional(),
      statusReason: z
        .enum(['client-certificate-missing', 'prusa-link-unqualified'])
        .optional(),
      alarms: z
        .strictObject({
          printError: z
            .string()
            .length(9)
            .regex(/^[0-9A-F]{4}-[0-9A-F]{4}$/)
            .nullable()
            .optional(),
          hmsCount: z
            .number()
            .int()
            .min(0)
            .max(PRINTER_HMS_MAX_ENTRIES)
            .nullable()
            .optional(),
          hmsCode: z
            .string()
            .length(19)
            .regex(/^[0-9A-F]{4}(?:-[0-9A-F]{4}){3}$/)
            .nullable()
            .optional(),
        })
        .optional(),
      progress: z.number().min(0).max(1).optional(),
      materials: z
        .array(
          z.strictObject({
            slot: text(32),
            materialType: text(64).optional(),
            colorHex: z
              .string()
              .regex(/^[0-9A-F]{8}$/)
              .optional(),
            remainingPercent: z.number().min(0).max(100).optional(),
            active: z.boolean().optional(),
            filamentDiameterMm: z.number().finite().positive().optional(),
            filamentDensityGramsPerCm3: z
              .number()
              .finite()
              .positive()
              .optional(),
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
      filename: text(255).optional(),
      printDuration: z.number().finite().nonnegative().optional(),
      totalDuration: z.number().finite().nonnegative().optional(),
      currentLayer: z.number().int().nonnegative().optional(),
      totalLayer: z.number().int().nonnegative().optional(),
      estimatedRemainingSeconds: z.number().finite().nonnegative().optional(),
      lastJob: z
        .strictObject({
          outcome: z.enum(['completed', 'cancelled', 'failed']),
          filename: text(255).optional(),
          printDuration: z.number().finite().nonnegative().optional(),
          totalDuration: z.number().finite().nonnegative().optional(),
          filamentUsedMillimetres: z.number().finite().nonnegative().optional(),
          filamentUsage: z.array(filamentUsage).max(17).optional(),
          /** Library version that was printed; absent for jobs started outside the library. */
          sha256: z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .optional(),
          plate: z.number().int().min(1).max(1000).optional(),
          endedAt: z.number().int().nonnegative(),
        })
        .optional(),
      toolTemperatureCelsius: z.number().finite().optional(),
      bedTemperatureCelsius: z.number().finite().optional(),
      toolTargetsCelsius: z
        .array(
          z.strictObject({
            tool: z.number().int().min(0).max(999),
            target: z.number().finite(),
          }),
        )
        .min(1)
        .max(32)
        .optional(),
      chamberTemperatureCelsius: z.number().finite().optional(),
      chamberTargetCelsius: z.number().finite().optional(),
      runEnergyWh: z.number().finite().nonnegative().optional(),
      observedAt: z.number().int().nonnegative(),
    })
    .refine(
      (value) =>
        value.state === 'offline' ||
        (value.state === 'unknown' && value.preformStatus !== undefined) ||
        (value.statusReason === 'prusa-link-unqualified' &&
          value.identity?.vendor === 'Prusa' &&
          !value.controls?.length) ||
        value.progress !== undefined,
      {
        path: ['progress'],
        message: 'Online state requires progress',
      },
    )
}

/** Historical validation for on-disk queue recovery only. */
export const LegacyQueuedPrinterState = printerStateSchema(true)
export const PrinterState = printerStateSchema(false)
export type PrinterState = z.infer<typeof PrinterState>
