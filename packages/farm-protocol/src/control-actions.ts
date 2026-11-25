import { z } from 'zod'

// Existing readers accept statusMessage but leave unknown states read-only.
// This reserved diagnostic marks current, verified Moonraker terminal evidence;
// a historical lastJob alone must never be used to infer current state.
export const MOONRAKER_CANCELLED_STATUS = 'moonraker:print_stats:cancelled'
export function controlObservationState(observation: {
  state: string
  statusMessage?: string | undefined
}): string {
  return observation.state === 'unknown' &&
    observation.statusMessage === MOONRAKER_CANCELLED_STATUS
    ? 'cancelled'
    : observation.state
}

export const ToolIndex = z.literal([0, 1, 2, 3])
export const ToolTemperatureArgs = z.strictObject({
  tool: ToolIndex,
  target_c: z.number().int().nonnegative(),
})

export const SpeedMode = z.enum(['silent', 'standard', 'sport', 'ludicrous'])
export type SpeedMode = z.infer<typeof SpeedMode>
export const SpeedModes = z
  .array(SpeedMode)
  .min(1)
  .max(4)
  .refine((modes) => new Set(modes).size === modes.length)

/** Missing advertisements preserve support for all speed levels. */
export function speedModeAllowed(
  modes: readonly SpeedMode[] | undefined,
  level: unknown,
): boolean {
  return (
    modes === undefined ||
    (typeof level === 'string' && modes.some((mode) => mode === level))
  )
}

/** Lifecycle actions; the dashboard labels and state machine cover exactly these. */
export const ControlAction = z.enum(['pause', 'resume', 'cancel'])
export type ControlAction = z.infer<typeof ControlAction>
/** Every action a signed 'printer-control' command may carry. */
export const PowerArguments = z.strictObject({
  device: z.string().min(1).max(128),
  on: z.boolean(),
})
export const ExtendedControlAction = z.enum([
  ...ControlAction.options,
  'emergency_stop',
  'set_temperature',
  'set_tool_temperature',
  'set_fan',
  'home',
  'set_light',
  'set_speed',
  'start_print',
  'start_library_print',
  'firmware_restart',
  'service',
  'power',
  'timelapse',
  'run_macro',
  'config_write',
  'load_filament',
  'unload_filament',
  'jog',
  'motors_off',
  'z_babystep',
  'set_factor',
  'extrude',
  'file_op',
  'exclude_object',
  'set_led',
  'set_pin',
  'queue_op',
  'bed_mesh',
  'gcode',
  'confirm_collection',
  'clear_hold',
  'set_camera_stream',
  'set_filament_slot',
])
export type ExtendedControlAction = z.infer<typeof ExtendedControlAction>
/** Optional, advisory detail of a command result. It never changes the outcome. */
export const ControlResultCode = z.enum([
  'signature',
  'scope',
  'state',
  'busy',
  'guard-denied',
  'bambu-authorization-required',
  'incompatible',
  'download-failed',
  'checksum-mismatch',
  'cache-full',
  'local-file-missing',
  'awaiting-collection',
  'tool-state-stale',
  'tool-printer-not-idle',
  'tool-heater-not-advertised',
  'tool-temperature-above-maximum',
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
/** The Anycubic LAN start envelope accepts stored raw G-code paths. */
export function isAnycubicStartFile(name: string): boolean {
  return (
    name.length <= 255 &&
    name.endsWith('.gcode') &&
    !/[\\\x00-\x1f\x7f%]/.test(name) &&
    !name.split('/').some((part) => !part || part === '.' || part === '..')
  )
}
const PlateNumber = z.number().int().min(1).max(1000)
export const LibraryPrintArgs = z.strictObject({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  plate: PlateNumber.optional(),
  ams_mapping: AmsMapping.optional(),
})
export type LibraryPrintArgs = z.infer<typeof LibraryPrintArgs>
/** Console line: one line of printable ASCII, at most 256 bytes. */
export const GCODE_LINE_MAX_BYTES = 256

/** Physical U1 operations can finish after their signed write authority expires. */
export const U1_CONTROL_RESULT_TIMEOUT_MS = 24_000

/**
 * Canonical console homing: `G28` with optional, distinct bare axes. The
 * driver routes exactly these lines through the structured `home` action.
 */
function isCanonicalHomeLine(line: string): boolean {
  const [word, ...axes] = line.trim().toUpperCase().split(/\s+/)
  return (
    word === 'G28' &&
    axes.every((axis) => /^[XYZ]$/.test(axis)) &&
    new Set(axes).size === axes.length
  )
}

export function isU1PhysicalControl(
  action: string,
  args: Record<string, unknown>,
): boolean {
  return (
    action === 'home' ||
    (action === 'gcode' &&
      typeof args.line === 'string' &&
      (/^T[0-3]$/i.test(args.line.trim()) || isCanonicalHomeLine(args.line)))
  )
}

export const GcodeLine = z
  .string()
  .min(1)
  .max(GCODE_LINE_MAX_BYTES)
  .refine((line) => !/[^\x20-\x7e]/.test(line))
  .refine((line) => line.trim().length > 0)
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
export const ServiceArguments = z.strictObject({
  op: z.enum(['klipper_restart', 'firmware_restart', 'moonraker_restart']),
})
export type ServiceOperation = z.infer<typeof ServiceArguments>['op']

/** Timelapse video: a plain file name in the timelapse root, no path. */
export const TimelapseFileName = z
  .string()
  .min(1)
  .max(255)
  .refine((v) => !/[\\/\x00-\x1f\x7f]/.test(v) && v !== '.' && v !== '..')
/** Render the captured frames, or delete one rendered video. */
export const TimelapseArguments = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('render') }),
  z.strictObject({ op: z.literal('delete'), file: TimelapseFileName }),
])
export type TimelapseArguments = z.infer<typeof TimelapseArguments>

/** Saved bed mesh profile name: a Klipper-safe token, never free text. */
export const MeshProfileName = z.string().regex(/^[A-Za-z0-9_]{1,32}$/)
export const BED_MESH_OPS = [
  'calibrate',
  'load',
  'save',
  'remove',
  'clear',
] as const
/**
 * `calibrate` takes an optional profile, `load`, `save` and `remove` need one
 * and `clear` takes none. No probe coordinates are ever sent: Klipper uses
 * its own configured mesh bounds.
 */
export const BedMeshArguments = z
  .strictObject({
    op: z.enum(BED_MESH_OPS),
    profile: MeshProfileName.optional(),
  })
  .refine(({ op, profile }) =>
    op === 'clear'
      ? profile === undefined
      : op === 'calibrate' || profile !== undefined,
  )
/** Starts or stops the printer's own camera stream server. */
export const CameraStreamArguments = z.strictObject({ on: z.boolean() })
/**
 * Material names a slot record may carry. Source: the AD5X material station
 * reference, Parallel-7/flashforge-api-docs wiki @ 885702f.
 */
export const FILAMENT_SLOT_MATERIALS = [
  'PLA',
  'PLA-CF',
  'ABS',
  'PETG',
  'PETG-CF',
  'TPU',
  'SILK',
  'PA-CF',
  'PC',
  'PC-ABS',
  'PET-CF',
  'PPS-CF',
  'PA',
  'PAHT-CF',
] as const
/** What the printer records for one slot. It moves no filament. */
export const FilamentSlotArguments = z.strictObject({
  tray: z.number().int().min(0).max(3),
  material: z.enum(FILAMENT_SLOT_MATERIALS),
  color: z.string().regex(/^#[0-9A-F]{6}$/),
})
/** Scope an API grant needs for `start_library_print`; roles follow `start_print`. */
export function controlRoleAllowed(
  role: string,
  action?: ExtendedControlAction,
): boolean {
  if (action === 'service') return role === 'owner'
  if (
    action === 'bed_mesh' ||
    action === 'power' ||
    action === 'run_macro' ||
    action === 'config_write' ||
    action === 'gcode' ||
    action === 'clear_hold'
  )
    return role === 'owner' || role === 'admin'
  return ['owner', 'admin', 'operator'].includes(role)
}
/** Motion, filament, macros and job starts never run while a print owns the printer. */
export const IDLE_ONLY_CONTROL_ACTIONS: ReadonlySet<string> = new Set([
  'home',
  'set_tool_temperature',
  'load_filament',
  'unload_filament',
  'run_macro',
  'start_print',
  'start_library_print',
])
/**
 * The one idle-only rule shared by every Connector entry point: true when
 * `action` must be refused as printer-busy because a print is running or paused.
 */
export function controlPrinterBusy(action: string, state: string): boolean {
  return (
    IDLE_ONLY_CONTROL_ACTIONS.has(action) &&
    (state === 'printing' || state === 'paused')
  )
}
export function controlSourceState(
  action: ExtendedControlAction,
  state: string,
): boolean {
  if (controlPrinterBusy(action, state)) return false
  if (action === 'set_tool_temperature' || action === 'set_filament_slot')
    return state === 'idle'
  if (action === 'exclude_object')
    return state === 'printing' || state === 'paused'
  // `clear_hold` never reaches the printer: the operator has checked it.
  if (action === 'emergency_stop' || action === 'clear_hold') return true
  // The operator says the bed is clear: only while no job owns the printer.
  if (action === 'confirm_collection')
    return state === 'idle' || state === 'cancelled' || state === 'error'
  // A library start uploads a file first: never onto a printer that is busy.
  if (action === 'start_library_print')
    return !['printing', 'paused', 'unknown', 'error'].includes(state)
  if (action === 'config_write')
    return state === 'idle' || state === 'cancelled'
  if (action === 'service') return state === 'idle' || state === 'cancelled'
  if (action === 'firmware_restart')
    return state === 'error' || state === 'idle'
  // Jogging and releasing the motors never run during a job.
  if (action === 'jog' || action === 'motors_off')
    return state === 'idle' || state === 'cancelled'
  // Extrusion moves filament: only a stopped printer may do it.
  if (action === 'bed_mesh' || action === 'file_op' || action === 'extrude')
    return state === 'idle' || state === 'cancelled'
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
export const PrinterGcodePath = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (path) =>
      !/[\\%:\u0000-\u001f\u007f-\u009f]/.test(path) &&
      path
        .split('/')
        .every(
          (part) =>
            part.trim() === part && part && part !== '.' && part !== '..',
        ),
  )
export const FileOperation = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('delete'), path: PrinterGcodePath }),
  z.strictObject({ op: z.literal('mkdir'), path: PrinterGcodePath }),
  z.strictObject({
    op: z.literal('move'),
    path: PrinterGcodePath,
    to: PrinterGcodePath,
  }),
])

export const ExcludeObjectArguments = z.strictObject({
  name: z
    .string()
    .max(128)
    .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/),
})
/** Most files or jobs one queue operation may name. */
export const QUEUE_OP_MAX_ITEMS = 32
/** Queue file: a gcodes-relative path, no traversal, no control characters. */
const QueueFileName = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (v) =>
      !/[\\\x00-\x1f\x7f]/.test(v) &&
      !v.startsWith('/') &&
      !v
        .split('/')
        .some((part) => part === '' || part === '..' || part === '.'),
  )
/** Moonraker queue job id, as the queue status reports it. */
const QueueJobId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
const uniqueItems = <T extends z.ZodType<string>>(item: T, max: number) =>
  z
    .array(item)
    .min(1)
    .max(max)
    .refine((values) => new Set(values).size === values.length)
/** One queue operation; each op names exactly the items it needs. */
export const QueueOpArguments = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('add'),
    files: uniqueItems(QueueFileName, QUEUE_OP_MAX_ITEMS),
  }),
  z.strictObject({
    op: z.literal('remove'),
    job_ids: uniqueItems(QueueJobId, QUEUE_OP_MAX_ITEMS),
  }),
  z.strictObject({
    op: z.literal('jump'),
    job_ids: uniqueItems(QueueJobId, 1),
  }),
  z.strictObject({ op: z.enum(['start', 'pause']) }),
])
export type QueueOpArguments = z.infer<typeof QueueOpArguments>
export const ConfigFileName = z
  .string()
  .regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,190}\.cfg$/)
const ConfigDigest = z.string().regex(/^[a-f0-9]{64}$/)
const configWriteBase = {
  path: ConfigFileName,
  base_sha256: ConfigDigest,
  restart: z.boolean().optional(),
}
export const ConfigWriteArguments = z.union([
  z.strictObject({ ...configWriteBase, sha256: ConfigDigest }),
  z
    .strictObject({ ...configWriteBase, backup: z.string().max(224) })
    .refine(
      ({ path, backup }) =>
        backup.startsWith(`${path}.openfarm-`) &&
        /^\d{13}\.bak$/.test(backup.slice(path.length + '.openfarm-'.length)),
    ),
])
/** The finished attempt (its end time in ms) whose bed the operator cleared. */
export const CollectionArguments = z.strictObject({
  attempt: z.string().regex(/^(?:0|[1-9][0-9]{0,15})$/),
})
export const ControlArguments = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('file_op'), args: FileOperation }),
  z.strictObject({
    action: z.literal('set_camera_stream'),
    args: CameraStreamArguments,
  }),
  z.strictObject({
    action: z.literal('set_filament_slot'),
    args: FilamentSlotArguments,
  }),
  z.strictObject({
    action: z.literal('config_write'),
    args: ConfigWriteArguments,
  }),
  z.strictObject({ action: z.literal('power'), args: PowerArguments }),
  z.strictObject({ action: z.literal('service'), args: ServiceArguments }),
  z.strictObject({ action: z.literal('timelapse'), args: TimelapseArguments }),
  z.strictObject({ action: z.literal('queue_op'), args: QueueOpArguments }),
  z.strictObject({
    action: z.literal('exclude_object'),
    args: ExcludeObjectArguments,
  }),
  z.strictObject({ action: z.literal('bed_mesh'), args: BedMeshArguments }),
  z.strictObject({
    action: z.literal('confirm_collection'),
    args: CollectionArguments,
  }),
  z.strictObject({ action: z.literal('extrude'), args: ExtrudeArguments }),
  z.strictObject({
    action: z.literal('run_macro'),
    args: z.strictObject({ name: MacroName, params: MacroParams.optional() }),
  }),
  z.strictObject({
    action: z.literal('gcode'),
    args: z.strictObject({ line: GcodeLine }),
  }),
  z.strictObject({
    action: z.literal('load_filament'),
    args: z.strictObject({
      // Global tray index: 0-15, or an AMS HT unit id (128-135).
      tray: z
        .union([
          z.number().int().min(0).max(15),
          z.number().int().min(128).max(135),
        ])
        .optional(),
    }),
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
      'clear_hold',
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
    action: z.literal('set_tool_temperature'),
    args: ToolTemperatureArgs,
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
      level: SpeedMode,
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
