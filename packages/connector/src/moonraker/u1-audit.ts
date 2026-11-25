import { DriverRefusalError } from '../control/driver-refusal.ts'
import { z } from 'zod'
import { ControlArguments } from '../../../farm-protocol/src/control-actions.ts'
import type { ControlObservation } from '../control/pause-dispatcher.ts'
import { ConsoleRefusal } from './control-console.ts'
import { klipperCommandName } from './klipper-command.ts'
import { type MotionState, MotionRefusal } from './control-motion.ts'
import { U1_TOOL_OBJECTS } from './u1-marker.ts'

type AuditEffect = NonNullable<ControlObservation['effect']>
export type U1Audit = {
  objects: Record<string, string[]>
  effect: (status: unknown, observedMono: number) => AuditEffect | undefined
  /** One `notify_gcode_response` text received while the command was in flight. */
  response?: (message: string) => void
}

export class U1ConfigRefusal extends DriverRefusalError {
  constructor(message: string) {
    super('state', message)
  }
}

const ConfigSettings = z.object({
  status: z.object({
    configfile: z.object({ settings: z.record(z.string(), z.unknown()) }),
  }),
})
export function u1ConfigSettings(result: unknown): Record<string, unknown> {
  const parsed = ConfigSettings.safeParse(result)
  if (!parsed.success) throw new U1ConfigRefusal('U1 settings unavailable')
  return parsed.data.status.configfile.settings
}

const HeaterLimits = z.object({ max_temp: z.number().finite().positive() })
export function requireU1HeaterLimit(
  settings: Record<string, unknown>,
  heater: string,
  target: number,
): void {
  const limit = HeaterLimits.safeParse(settings[heater])
  if (!limit.success || target > limit.data.max_temp)
    throw new U1ConfigRefusal('U1 heater target outside configured limit')
}

export function u1TemperatureAudit(
  action: 'set_temperature' | 'set_tool_temperature',
  args: Record<string, unknown>,
): U1Audit & { heater: string; target: number } {
  const parsed = ControlArguments.parse({ action, args })
  if (
    parsed.action !== 'set_tool_temperature' &&
    parsed.action !== 'set_temperature'
  )
    throw Error('Invalid U1 heater action')
  const object =
    parsed.action === 'set_tool_temperature'
      ? U1_TOOL_OBJECTS[parsed.args.tool]
      : parsed.args.heater === 'bed'
        ? 'heater_bed'
        : 'extruder'
  const temperatureStatus = z.object({
    [object]: z.object({ target: z.number().int().nonnegative() }),
  })
  return {
    heater: object,
    target: parsed.args.target_c,
    objects: { [object]: ['target'] },
    effect(status, observedMono) {
      const result = temperatureStatus.safeParse(status)
      const target_c = result.success ? result.data[object]?.target : undefined
      if (target_c === undefined) return
      return parsed.action === 'set_tool_temperature'
        ? {
            kind: 'tool-temperature',
            tool: parsed.args.tool,
            target_c,
            observedMono,
          }
        : {
            kind: 'temperature',
            heater: parsed.args.heater,
            target_c,
            observedMono,
          }
    },
  }
}

const HomedToolhead = z.object({
  toolhead: z.object({ homed_axes: z.string().regex(/^[xyz]{0,3}$/) }),
})
const PositionedToolhead = z.object({
  toolhead: z.object({ position: z.array(z.number().finite()).min(3) }),
})
const StepperLimits = z.object({
  position_min: z.number().finite(),
  position_max: z.number().finite(),
})
const PrinterLimits = z.object({
  max_velocity: z.number().finite().positive(),
  max_z_velocity: z.number().finite().positive().optional(),
})

export function u1HomeAudit(
  args: Record<string, unknown>,
): U1Audit & { zOnly: boolean } {
  const parsed = ControlArguments.parse({ action: 'home', args })
  if (parsed.action !== 'home') throw Error('Invalid U1 home action')
  const { axes } = parsed.args
  // The firmware always homes both XY axes if either is requested.
  if (axes.includes('x') !== axes.includes('y'))
    throw new DriverRefusalError('invalid-command', 'U1 homes X and Y together')
  return {
    zOnly: axes.length === 1 && axes[0] === 'z',
    objects: { toolhead: ['homed_axes'] },
    effect(status, observedMono) {
      const result = HomedToolhead.safeParse(status)
      if (
        result.success &&
        axes.every((axis) => result.data.toolhead.homed_axes.includes(axis))
      )
        return { kind: 'motion', action: 'home', observedMono }
    },
  }
}

export function u1JogAudit(
  args: Record<string, unknown>,
  state: MotionState,
  settings: Record<string, unknown>,
): U1Audit {
  const parsed = ControlArguments.parse({ action: 'jog', args })
  if (parsed.action !== 'jog') throw Error('Invalid U1 jog action')
  const axis = 'xyz'.indexOf(parsed.args.axis)
  const current = state.position[axis]
  if (current === undefined) throw new MotionRefusal('unknown-state')
  const target = current + parsed.args.distance_mm
  const stepper = StepperLimits.safeParse(
    settings[`stepper_${parsed.args.axis}`],
  )
  const printer = PrinterLimits.safeParse(settings.printer)
  if (!stepper.success || !printer.success)
    throw new U1ConfigRefusal('U1 motion limits unavailable')
  const { position_min, position_max } = stepper.data
  const { max_velocity, max_z_velocity } = printer.data
  const velocity =
    parsed.args.axis === 'z' && max_z_velocity !== undefined
      ? Math.min(max_velocity, max_z_velocity)
      : max_velocity
  if (
    position_min >= position_max ||
    target < position_min ||
    target > position_max ||
    parsed.args.feed / 60 > velocity
  )
    throw new U1ConfigRefusal('U1 jog outside configured limits')
  return {
    objects: { toolhead: ['position'] },
    effect(status, observedMono) {
      const result = PositionedToolhead.safeParse(status)
      const observed = result.success
        ? result.data.toolhead.position[axis]
        : undefined
      if (observed !== undefined && Math.abs(observed - target) <= 0.001)
        return { kind: 'motion', action: 'jog', observedMono }
    },
  }
}

const ActiveToolhead = z.object({
  toolhead: z.object({ extruder: z.string() }),
})

/** Vendor Klipper registers exactly T0–T3. The ordinary console policy still applies. */
export function u1ConsoleTool(
  line: string,
  objects: readonly string[] | undefined,
) {
  // Klipper strips leading N-line numbers and normalizes spaced traditional G-code.
  if (/^N\s*[+-]?\s*\d/i.test(line)) throw new ConsoleRefusal('not-allowed')
  if (!/^T\s*[+-]?\s*\d/i.test(line)) return
  const tool = U1_TOOL_OBJECTS.find(
    (_, index) => line.toUpperCase() === `T${index}`,
  )
  if (!tool) throw new ConsoleRefusal('not-allowed')
  if (!objects?.includes('toolhead') || !objects.includes(tool))
    throw new ConsoleRefusal('unsupported')
  return tool
}

/*
 * Report formats of the built-in query commands, identical in both:
 * - https://github.com/Klipper3d/klipper at c9559fa04ec6b11fb1a9a1610903546319fcf310
 * - https://github.com/Snapmaker/u1-klipper at 7ac453b50fe6779b2ec0b759038a17da5e6d671d
 * Paths are under klippy/: `gcode.py` (respond_info prefixes each line with
 * "// "; cmd_M115), `extras/heaters.py` (_get_temp, cmd_M105),
 * `extras/gcode_move.py` (cmd_M114, cmd_GET_POSITION),
 * `extras/query_endstops.py`, `extras/probe.py` (cmd_QUERY_PROBE),
 * `extras/query_adc.py` and `extras/filament_switch_sensor.py`.
 * Moonraker b559b9a81161f958a43c2f527b6ad96f73310d5d,
 * moonraker/components/klippy_connection.py (_process_gcode_response), relays
 * each text as `notify_gcode_response`. Only the formats are used, no code.
 */
const ENDSTOP = '\\w+:(?:open|TRIGGERED)'
const QUERY_REPORTS: Readonly<
  Record<string, (message: string, params: string) => boolean>
> = {
  // The "T:0" placeholder of a printer without sensors is not a reading.
  M105: (message) =>
    /^(?:(?:T\d*|B|C):-?\d+\.\d \/-?\d+\.\d(?: |$))+/.test(message),
  M114: (message) =>
    /^X:-?\d+\.\d{3} Y:-?\d+\.\d{3} Z:-?\d+\.\d{3} E:-?\d+\.\d{3}$/.test(
      message,
    ),
  M115: (message) => /^\/\/ .*\bFIRMWARE_NAME:\S/.test(message),
  GET_POSITION: (message) =>
    /^\/\/ mcu: [\s\S]*\n\/\/ toolhead: [\s\S]*\n\/\/ gcode homing: /.test(
      message,
    ),
  QUERY_ENDSTOPS: (message) =>
    new RegExp(`^${ENDSTOP}(?: ${ENDSTOP})*$`).test(message),
  QUERY_PROBE: (message) => /^\/\/ probe: (?:open|TRIGGERED)$/.test(message),
  QUERY_ADC(message, params) {
    const name = /(?:^| )NAME=(\S+)/i.exec(params)?.[1]
    return message.startsWith(
      name
        ? `// ADC object "${name}" has value `
        : '// Available ADC objects: ',
    )
  },
  QUERY_FILAMENT_SENSOR(message, params) {
    const name = /(?:^| )SENSOR=(\S+)/i.exec(params)?.[1]
    return (
      !!name &&
      new RegExp(
        `^// Filament Sensor ${name.replace(/[.+]/g, '\\$&')}: filament (?:not )?detected$`,
      ).test(message)
    )
  },
}

const BedTargetStatus = z.object({
  heater_bed: z.object({ target: z.number().finite() }),
})
const SpeedFactorStatus = z.object({
  gcode_move: z.object({ speed_factor: z.number().finite() }),
})

type Readback = {
  objects: Record<string, string[]>
  confirmed: (status: unknown) => boolean
}

/** Output-only commands: the script acknowledgement is all the evidence there is. */
const READ_ONLY_COMMANDS = new Set(['M118'])

/**
 * How to read back the state a console line leaves behind. `undefined` means
 * the effect cannot be read: the line was sent and acknowledged, but it is
 * reported as unconfirmed rather than applied.
 */
function consoleReadback(
  command: string,
  params: readonly string[],
): Readback | undefined {
  if (READ_ONLY_COMMANDS.has(command))
    return { objects: {}, confirmed: () => true }
  if (
    command === 'M140' &&
    params.length === 1 &&
    /^S0(?:\.0+)?$/i.test(params[0]!)
  )
    return {
      objects: { heater_bed: ['target'] },
      confirmed(status) {
        const result = BedTargetStatus.safeParse(status)
        return result.success && result.data.heater_bed.target === 0
      },
    }
  const speed = /^S(\d{1,3})$/i.exec(params[0] ?? '')
  if (command === 'M220' && params.length === 1 && speed)
    return {
      objects: { gcode_move: ['speed_factor'] },
      confirmed(status) {
        const result = SpeedFactorStatus.safeParse(status)
        return (
          result.success &&
          Math.abs(
            result.data.gcode_move.speed_factor - Number(speed[1]) / 100,
          ) <= 0.0005
        )
      },
    }
}

/**
 * Evidence for a console line. Only tool selection, canonical homing and the
 * few lines whose state can be read back are ever confirmed; any other line
 * has no effect to offer, so it ends as sent but unconfirmed and is not retried.
 */
export function u1ConsoleAudit(
  line: string,
  tool?: string,
  home?: U1Audit,
): U1Audit {
  const command = klipperCommandName(line)
  const [, ...params] = line.trim().split(/\s+/)
  const readback = tool || home ? undefined : consoleReadback(command, params)
  const isQuery =
    command.startsWith('QUERY_') ||
    ['M105', 'M114', 'M115', 'GET_POSITION'].includes(command)
  let reported = false
  return {
    response(message) {
      if (QUERY_REPORTS[command]?.(message, params.join(' '))) reported = true
    },
    objects: tool
      ? { toolhead: ['extruder'] }
      : (home?.objects ?? readback?.objects ?? {}),
    effect(status, observedMono) {
      if (tool) {
        const result = ActiveToolhead.safeParse(status)
        if (!result.success || result.data.toolhead.extruder !== tool) return
      } else if (home) {
        // The console home is signed as `gcode` but proven by the homed axes.
        if (!home.effect(status, observedMono)) return
      } else if (isQuery ? !reported : !readback?.confirmed(status)) return
      return { kind: 'gcode', line, observedMono }
    },
  }
}
