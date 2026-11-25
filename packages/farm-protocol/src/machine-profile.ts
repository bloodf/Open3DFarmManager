import { z } from 'zod'

const nozzleDiameterMm = z.number().finite().positive().max(10)
const bedAxisMm = z.number().finite().positive().max(10_000)
const temperatureCelsius = z.number().finite().positive().max(1_000)

/** Most tools a profile may describe; larger machines omit tool fields. */
export const MACHINE_PROFILE_MAX_TOOLS = 8

/** One attached filament unit, as the printer reports it. */
export const MachineMaterialUnit = z.strictObject({
  id: z.number().int().min(0).max(255),
  kind: z.enum(['ams', 'ams-lite', 'ams-2-pro', 'ams-ht']),
  slots: z.number().int().min(1).max(4),
  /** Tool the unit feeds; omitted when it is not bound to one. */
  tool: z
    .number()
    .int()
    .min(0)
    .max(MACHINE_PROFILE_MAX_TOOLS - 1)
    .optional(),
})

/**
 * Static hardware limits of one printer, for compatibility checks.
 *
 * Every field is optional and means "known": an unknown value is omitted,
 * never guessed or defaulted. `nozzleDiametersMm` is indexed by tool and is
 * present only when every tool's diameter is known.
 */
export const MachineProfile = z
  .strictObject({
    /** Model name the printer itself reports, where identity carries none. */
    model: z.string().trim().min(1).max(64).optional(),
    toolCount: z
      .number()
      .int()
      .min(1)
      .max(MACHINE_PROFILE_MAX_TOOLS)
      .optional(),
    nozzleDiametersMm: z
      .array(nozzleDiameterMm)
      .min(1)
      .max(MACHINE_PROFILE_MAX_TOOLS)
      .optional(),
    bedSizeMm: z
      .strictObject({ x: bedAxisMm, y: bedAxisMm, z: bedAxisMm })
      .optional(),
    maxHotendCelsius: temperatureCelsius.optional(),
    maxBedCelsius: temperatureCelsius.optional(),
    kinematics: z
      .string()
      .regex(/^[a-z0-9_]{1,32}$/)
      .optional(),
    materialUnits: z.array(MachineMaterialUnit).min(1).max(12).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Empty machine profile')
  .refine(
    (value) =>
      value.toolCount === undefined ||
      value.nozzleDiametersMm === undefined ||
      value.nozzleDiametersMm.length === value.toolCount,
    { path: ['nozzleDiametersMm'], message: 'One nozzle diameter per tool' },
  )
export type MachineProfile = z.infer<typeof MachineProfile>
