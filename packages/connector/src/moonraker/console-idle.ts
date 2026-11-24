import { z } from 'zod'
import { checkExtrudeProbe } from './control-extrusion.ts'
import { ConsoleRefusal } from './control-console.ts'

export function idleConsoleQueryWire(
  id: number,
  objects: readonly string[],
): string {
  const queries: Record<string, string[] | null> = {
    webhooks: ['state'],
    print_stats: ['state'],
    toolhead: ['homed_axes', 'position', 'extruder'],
    gcode_move: [
      'absolute_coordinates',
      'absolute_extrude',
      'gcode_position',
      'speed',
      'speed_factor',
      'extrude_factor',
    ],
  }
  for (const name of objects)
    if (EXTRUDER.test(name)) queries[name] = ['temperature', 'can_extrude']
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'printer.objects.query',
    params: { objects: queries },
  })
}

const MAX_MOVE_MM = 50
const MAX_FEED_MM_MIN = 150 * 60
const MAX_EXTRUSION_MM = 10
const EXTRUDER = /^extruder(?:[1-9]\d*)?$/

const finite = z.number().finite()
const snapshot = z.object({
  status: z
    .object({
      webhooks: z.object({ state: z.literal('ready') }),
      print_stats: z.object({
        state: z.enum(['standby', 'complete', 'cancelled']),
      }),
      toolhead: z.object({
        homed_axes: z.string().regex(/^[xyz]{0,3}$/),
        position: z.array(finite).min(3),
        extruder: z.string(),
      }),
      gcode_move: z.unknown(),
    })
    .catchall(z.unknown()),
})
const gcodeMove = z.object({
  absolute_coordinates: z.boolean(),
  absolute_extrude: z.boolean(),
  gcode_position: z.array(finite).min(4),
  speed: finite.positive(),
  speed_factor: finite.positive(),
  extrude_factor: finite.positive(),
})
const section = z.object({ position_min: finite, position_max: finite })
const heater = z.object({ max_temp: finite.positive() })
const configfile = z.object({
  status: z.object({
    configfile: z.object({ settings: z.record(z.string(), z.unknown()) }),
  }),
})

export function guardIdleConsole(
  line: string,
  live: unknown,
  config: unknown,
): void {
  const parsed = snapshot.safeParse(live)
  const configured = configfile.safeParse(config)
  if (!parsed.success || !configured.success)
    throw new ConsoleRefusal('unknown-state')
  const { settings } = configured.data.status.configfile
  const state = parsed.data.status
  const [raw, ...parts] = line.trim().toUpperCase().split(/\s+/)
  const values: Record<string, number> = {}
  for (const part of parts) {
    const match = /^([XYZEFS])(-?\d+(?:\.\d+)?)$/.exec(part)
    if (!match || values[match[1]!] !== undefined)
      throw new ConsoleRefusal('invalid')
    const value = Number(match[2])
    if (!Number.isFinite(value)) throw new ConsoleRefusal('invalid')
    values[match[1]!] = value
  }
  if (raw === 'M104' || raw === 'M109' || raw === 'M140' || raw === 'M190') {
    if (
      Object.keys(values).some((k) => k !== 'S') ||
      values.S === undefined ||
      values.S < 0
    )
      throw new ConsoleRefusal('invalid')
    const name =
      raw === 'M104' || raw === 'M109' ? state.toolhead.extruder : 'heater_bed'
    if (name !== 'heater_bed' && !EXTRUDER.test(name))
      throw new ConsoleRefusal('unknown-state')
    const limit = heater.safeParse(settings[name])
    if (!limit.success || values.S > limit.data.max_temp)
      throw new ConsoleRefusal('limit')
    return
  }
  if (raw !== 'G0' && raw !== 'G1') throw new ConsoleRefusal('not-allowed')
  if (Object.keys(values).some((k) => !'XYZEF'.includes(k)))
    throw new ConsoleRefusal('invalid')
  const motion = gcodeMove.safeParse(state.gcode_move)
  if (!motion.success) throw new ConsoleRefusal('unknown-state')
  const move = motion.data
  // Klipper reports the modal speed in mm/s before applying M220.
  const feed =
    values.F === undefined
      ? move.speed * move.speed_factor * 60
      : values.F * move.speed_factor
  if (feed <= 0 || feed > MAX_FEED_MM_MIN || (values.F ?? 0) > MAX_FEED_MM_MIN)
    throw new ConsoleRefusal('limit')
  let distanceSquared = 0
  for (const [index, axis] of ['X', 'Y', 'Z'].entries()) {
    const value = values[axis]
    if (value === undefined) continue
    if (!state.toolhead.homed_axes.includes(axis.toLowerCase()))
      throw new ConsoleRefusal('unhomed')
    const delta = move.absolute_coordinates
      ? value - move.gcode_position[index]!
      : value
    const bounds = section.safeParse(settings[`stepper_${axis.toLowerCase()}`])
    const target = state.toolhead.position[index]! + delta
    if (
      !bounds.success ||
      bounds.data.position_min >= bounds.data.position_max ||
      state.toolhead.position[index]! < bounds.data.position_min ||
      state.toolhead.position[index]! > bounds.data.position_max ||
      target < bounds.data.position_min ||
      target > bounds.data.position_max
    )
      throw new ConsoleRefusal('limit')
    distanceSquared += delta * delta
  }
  if (Math.sqrt(distanceSquared) > MAX_MOVE_MM)
    throw new ConsoleRefusal('limit')
  if (values.E !== undefined) {
    const e =
      move.absolute_extrude && move.absolute_coordinates
        ? values.E - move.gcode_position[3]!
        : values.E
    if (
      Math.abs(e) > MAX_EXTRUSION_MM ||
      Math.abs(e * move.extrude_factor) > MAX_EXTRUSION_MM
    )
      throw new ConsoleRefusal('limit')
    const name = state.toolhead.extruder
    try {
      checkExtrudeProbe({ status: { [name]: state[name] } }, name)
    } catch {
      throw new ConsoleRefusal('unknown-state')
    }
  }
}
