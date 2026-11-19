import { z } from 'zod'

/** Lifecycle actions; the dashboard labels and state machine cover exactly these. */
export const ControlAction = z.enum(['pause', 'resume', 'cancel'])
export type ControlAction = z.infer<typeof ControlAction>
/** Every action a signed 'printer-control' command may carry. */
export const ExtendedControlAction = z.enum([
  ...ControlAction.options,
  'emergency_stop',
  'set_temperature',
  'set_fan',
  'home',
  'set_light',
  'set_speed',
  'start_print',
  'start_library_print',
  'firmware_restart',
  'run_macro',
  'load_filament',
  'unload_filament',
  'jog',
  'motors_off',
  'z_babystep',
  'set_factor',
  'extrude',
  'set_led',
  'set_pin',
])
export type ExtendedControlAction = z.infer<typeof ExtendedControlAction>
/** Optional, advisory detail of a command result. It never changes the outcome. */
export const ControlResultCode = z.enum([
  'bambu-authorization-required',
  'incompatible',
  'download-failed',
  'checksum-mismatch',
  'cache-full',
  'local-file-missing',
])
export type ControlResultCode = z.infer<typeof ControlResultCode>
export const MOONRAKER_CONTROLS: readonly ControlAction[] = Object.freeze([
  'pause',
  'resume',
  'cancel',
])
export function controlsForBackend(backend: string): readonly ControlAction[] {
  return backend === 'moonraker' ? MOONRAKER_CONTROLS : []
}
/** Klipper object name (the part after the section type); never free text. */
export const OutputName = z.string().regex(/^[A-Za-z0-9_]{1,64}$/)
const Channel = z.number().int().min(0).max(255)
/** LED channels are 0-255; `w` is left out for RGB-only strips. */
export const SetLedArguments = z.strictObject({
  name: OutputName,
  r: Channel,
  g: Channel,
  b: Channel,
  w: Channel.optional(),
})
/** PWM duty or digital level, 0 to 1 (Klipper's default `scale`). */
export const SetPinArguments = z.strictObject({
  name: OutputName,
  value: z.number().finite().min(0).max(1),
})
/** Scope an API grant needs for `start_library_print`; roles follow `start_print`. */
export const LIBRARY_PRINT_API_SCOPE = 'jobs:write'
/** One Bambu AMS slot per filament of the plate; -1 leaves a filament unmapped. */
export const AmsMapping = z.array(z.number().int().min(-1).max(255)).max(64)
/** `start_print` file name: a plain name, no path or control characters. */
const PrintFileName = z
  .string()
  .min(1)
  .max(255)
  .refine((v) => !/[\\/\x00-\x1f\x7f]/.test(v) && !v.includes('..'))
const PlateNumber = z.number().int().min(1).max(1000)
export const LibraryPrintArgs = z.strictObject({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  plate: PlateNumber.optional(),
  ams_mapping: AmsMapping.optional(),
})
export type LibraryPrintArgs = z.infer<typeof LibraryPrintArgs>
export const MacroName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
export const MACRO_PARAM_MAX_KEYS = 16
export const MACRO_PARAM_MAX_VALUE_CHARS = 64
/** Klipper macro parameter name: a safe identifier. */
export const MacroParamName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,31}$/)
/**
 * One G-code token: no whitespace, control characters, `;` (command
 * separator) or `#`/`*` (comment and checksum), so a value never splits a
 * script line or smuggles a second command.
 */
export const MacroParamValue = z
  .string()
  .min(1)
  .max(MACRO_PARAM_MAX_VALUE_CHARS)
  .regex(/^[^\s\x00-\x1f\x7f;#*]+$/)
/** Bounded `KEY=value` parameters of one macro run. */
export const MacroParams = z.custom<Record<string, string>>((value) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const keys = Object.keys(value)
  return (
    keys.length <= MACRO_PARAM_MAX_KEYS &&
    keys.every(
      (key) =>
        MacroParamName.safeParse(key).success &&
        MacroParamValue.safeParse((value as Record<string, unknown>)[key])
          .success,
    )
  )
})
export function controlRoleAllowed(
  role: string,
  action?: ExtendedControlAction,
): boolean {
  if (action === 'run_macro') return role === 'owner' || role === 'admin'
  return ['owner', 'admin', 'operator'].includes(role)
}
export function controlSourceState(
  action: ExtendedControlAction,
  state: string,
): boolean {
  if (action === 'emergency_stop') return true
  if (action === 'firmware_restart')
    return state === 'error' || state === 'idle'
  // Jogging and releasing the motors never run during a job.
  if (action === 'jog' || action === 'motors_off')
    return state === 'idle' || state === 'cancelled'
  // Extrusion moves filament: only a stopped printer may do it.
  if (action === 'extrude') return state === 'idle' || state === 'cancelled'
  if (!['pause', 'resume', 'cancel'].includes(action))
    return state !== 'unknown' && state !== 'error'
  return action === 'resume'
    ? state === 'paused'
    : action === 'cancel'
      ? state === 'printing' || state === 'paused'
      : state === 'printing'
}
export function controlTargetState(
  action: ExtendedControlAction,
): 'paused' | 'printing' | 'cancelled' {
  return action === 'pause'
    ? 'paused'
    : action === 'resume'
      ? 'printing'
      : 'cancelled'
}

const signedStep = (min: number, max: number, step: number) =>
  z
    .number()
    .finite()
    .refine(
      (value) =>
        Math.abs(value) >= min - 1e-9 &&
        Math.abs(value) <= max + 1e-9 &&
        Math.abs(value / step - Math.round(value / step)) < 1e-6,
    )

/** Tool index, signed length (negative retracts) and feed rate in mm/min. */
export const ExtrudeArguments = z.strictObject({
  tool: z.number().int().min(0).max(15),
  length_mm: z
    .number()
    .finite()
    .min(-50)
    .max(100)
    .refine((value) => value !== 0),
  feed: z.number().finite().min(1).max(6000),
})
export const ControlArguments = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('extrude'), args: ExtrudeArguments }),
  z.strictObject({
    action: z.literal('run_macro'),
    args: z.strictObject({ name: MacroName, params: MacroParams.optional() }),
  }),
  z.strictObject({
    action: z.literal('load_filament'),
    args: z.strictObject({ tray: z.number().int().min(0).max(15).optional() }),
  }),
  z.strictObject({
    action: z.enum([
      'pause',
      'resume',
      'cancel',
      'emergency_stop',
      'firmware_restart',
      'unload_filament',
      'motors_off',
    ]),
    args: z.strictObject({}),
  }),
  z.strictObject({
    action: z.literal('jog'),
    args: z.strictObject({
      axis: z.enum(['x', 'y', 'z']),
      // Signed: the sign is the direction. Magnitude 0.01-100 mm in 0.01 steps.
      distance_mm: signedStep(0.01, 100, 0.01),
      feed: z.number().int().min(60).max(18000),
    }),
  }),
  z.strictObject({
    action: z.literal('z_babystep'),
    args: z.strictObject({ delta_mm: signedStep(0.001, 0.1, 0.001) }),
  }),
  z.strictObject({
    action: z.literal('set_factor'),
    args: z.strictObject({
      speed_pct: z.number().int().min(10).max(300),
      flow_pct: z.number().int().min(50).max(150),
    }),
  }),
  z.strictObject({
    action: z.literal('set_temperature'),
    args: z.strictObject({
      heater: z.enum(['extruder', 'bed', 'chamber']),
      target_c: z.number().int().nonnegative(),
    }),
  }),
  z.strictObject({
    action: z.literal('set_fan'),
    args: z.strictObject({
      // 'part' is the default fan; any other value is a fan_generic or
      // controller_fan name the Connector checks against the object list.
      fan: OutputName,
      percent: z.number().int().min(0).max(100),
    }),
  }),
  z.strictObject({
    action: z.literal('set_led'),
    args: SetLedArguments,
  }),
  z.strictObject({
    action: z.literal('set_pin'),
    args: SetPinArguments,
  }),
  z.strictObject({
    action: z.literal('home'),
    args: z.strictObject({
      axes: z
        .array(z.enum(['x', 'y', 'z']))
        .min(1)
        .max(3)
        .refine((v) => new Set(v).size === v.length),
    }),
  }),
  z.strictObject({
    action: z.literal('set_light'),
    args: z.strictObject({ on: z.boolean() }),
  }),
  z.strictObject({
    action: z.literal('set_speed'),
    args: z.strictObject({
      level: z.enum(['silent', 'standard', 'sport', 'ludicrous']),
    }),
  }),
  z.strictObject({
    action: z.literal('start_print'),
    args: z.strictObject({
      file: PrintFileName,
      plate: PlateNumber.optional(),
      ams_mapping: AmsMapping.optional(),
    }),
  }),
  z.strictObject({
    action: z.literal('start_library_print'),
    args: LibraryPrintArgs,
  }),
])
export type ControlArgs = z.infer<typeof ControlArguments>['args']
