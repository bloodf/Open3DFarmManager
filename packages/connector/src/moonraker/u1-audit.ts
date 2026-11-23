import { z } from 'zod'
import { ControlArguments } from '../../../farm-protocol/src/control-actions.ts'
import type { ControlObservation } from '../control/pause-dispatcher.ts'
import { ConsoleRefusal } from './control-console.ts'
import { type MotionState, MotionRefusal } from './control-motion.ts'
import { U1_TOOL_OBJECTS } from './u1-marker.ts'

type AuditEffect = NonNullable<ControlObservation['effect']>
export type U1Audit = {
  objects: Record<string, string[]>
  effect: (status: unknown, observedMono: number) => AuditEffect | undefined
}

export class U1ConfigRefusal extends Error {
  readonly refusal = 'state' as const
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
    throw Object.assign(Error('U1 homes X and Y together'), {
      refusal: 'invalid-command',
    })
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

export function u1ConsoleAudit(line: string, tool?: string): U1Audit {
  return {
    objects: tool ? { toolhead: ['extruder'] } : {},
    effect(status, observedMono) {
      if (tool) {
        const result = ActiveToolhead.safeParse(status)
        if (!result.success || result.data.toolhead.extruder !== tool) return
      }
      // Arbitrary console lines only have the matching script acknowledgement.
      // Their output is still delivered by the separate console response stream.
      return { kind: 'gcode', line, observedMono }
    },
  }
}
