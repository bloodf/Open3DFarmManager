import { DriverRefusalError } from '../control/driver-refusal.ts'
import { z } from 'zod'
import { ControlArguments } from '../../../farm-protocol/src/control-actions.ts'

/**
 * Moonraker adapter for the signed motion actions: jog, motors_off,
 * z_babystep and set_factor. Scripts are built only from validated numbers and
 * a fixed axis set, never from wire text. State-dependent refusals (unhomed,
 * printing, out of range) are decided here from one toolhead read taken just
 * before the single send; the caller never retries an uncertain command.
 */

export const MOTION_ACTIONS = [
  'jog',
  'motors_off',
  'z_babystep',
  'set_factor',
] as const
export type MotionAction = (typeof MOTION_ACTIONS)[number]
export const isMotionAction = (action: string): action is MotionAction =>
  (MOTION_ACTIONS as readonly string[]).includes(action)

const EPSILON = 1e-6

/** Why the Connector refused a motion action before sending anything. */
export type MotionRefusalCode =
  | 'invalid'
  | 'unsupported'
  | 'unknown-state'
  | 'printing'
  | 'unhomed'
  | 'out-of-range'
export class MotionRefusal extends DriverRefusalError {
  readonly code: MotionRefusalCode
  constructor(code: MotionRefusalCode) {
    super(
      code === 'invalid'
        ? 'invalid-command'
        : code === 'unsupported'
          ? 'unsupported-action'
          : 'state',
      `Motion refused: ${code}`,
    )
    this.name = 'MotionRefusal'
    this.code = code
  }
}

/** Motion needs the printer's own toolhead object; nothing is assumed. */
export function motionSupported(objects: readonly string[] | undefined) {
  return !!objects?.includes('toolhead')
}

const number = z.number().finite()
const axes = z.tuple([number, number, number]).rest(number).readonly()
/** One printer.objects.query reply for the fields below, nothing else. */
export const MotionSnapshot = z.strictObject({
  eventtime: number.nonnegative(),
  status: z.strictObject({
    webhooks: z.strictObject({
      state: z.enum(['ready', 'startup', 'shutdown', 'error']),
    }),
    print_stats: z.strictObject({
      state: z.enum([
        'standby',
        'printing',
        'paused',
        'error',
        'complete',
        'cancelled',
      ]),
    }),
    toolhead: z.strictObject({
      homed_axes: z.string().regex(/^[xyz]{0,3}$/),
      position: axes,
      axis_minimum: axes,
      axis_maximum: axes,
    }),
  }),
})
export type MotionState = Readonly<{
  ready: boolean
  printState: z.infer<typeof MotionSnapshot>['status']['print_stats']['state']
  homedAxes: string
  position: readonly number[]
  axisMinimum: readonly number[]
  axisMaximum: readonly number[]
}>

export function motionQueryWire(id: number): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'printer.objects.query',
    params: {
      objects: {
        webhooks: ['state'],
        print_stats: ['state'],
        toolhead: ['homed_axes', 'position', 'axis_minimum', 'axis_maximum'],
      },
    },
  })
}

/** Parses a query reply; anything else is "unknown state", which refuses. */
export function parseMotionState(result: unknown): MotionState {
  const parsed = MotionSnapshot.safeParse(result)
  if (!parsed.success) throw new MotionRefusal('unknown-state')
  const { webhooks, print_stats, toolhead } = parsed.data.status
  return Object.freeze({
    ready: webhooks.state === 'ready',
    printState: print_stats.state,
    homedAxes: toolhead.homed_axes,
    position: Object.freeze([...toolhead.position]),
    axisMinimum: Object.freeze([...toolhead.axis_minimum]),
    axisMaximum: Object.freeze([...toolhead.axis_maximum]),
  })
}

/** Actions that move or release the toolhead and so need a read of its state. */
export const motionNeedsState = (action: MotionAction) =>
  action === 'jog' || action === 'motors_off'

/**
 * Connector-side refusal. Jog and motors_off never run while a job is
 * printing or paused; a jog also needs its axis homed and a target inside the
 * axis limits. Babystep and factors are allowed while printing.
 */
export function refuseMotion(
  action: MotionAction,
  args: Record<string, unknown>,
  state: MotionState | undefined,
): void {
  if (!motionNeedsState(action)) return
  if (!state?.ready) throw new MotionRefusal('unknown-state')
  if (state.printState === 'printing' || state.printState === 'paused')
    throw new MotionRefusal('printing')
  if (state.printState === 'error') throw new MotionRefusal('unknown-state')
  if (action === 'motors_off') return
  const parsed = ControlArguments.safeParse({ action, args })
  if (!parsed.success || parsed.data.action !== 'jog')
    throw new MotionRefusal('invalid')
  const { axis, distance_mm } = parsed.data.args
  const index = 'xyz'.indexOf(axis)
  if (!state.homedAxes.includes(axis)) throw new MotionRefusal('unhomed')
  const current = state.position[index]
  const minimum = state.axisMinimum[index]
  const maximum = state.axisMaximum[index]
  if (
    current === undefined ||
    minimum === undefined ||
    maximum === undefined ||
    current + distance_mm < minimum - EPSILON ||
    current + distance_mm > maximum + EPSILON
  )
    throw new MotionRefusal('out-of-range')
}

const mm = (value: number) => Number(value.toFixed(3)).toString()

/** The one G-code script for an action, from validated arguments only. */
export function buildMotionScript(
  action: MotionAction,
  args: Record<string, unknown>,
): string {
  const parsed = ControlArguments.safeParse({ action, args })
  if (!parsed.success) throw new MotionRefusal('invalid')
  const call = parsed.data
  switch (call.action) {
    case 'jog':
      // Relative move and the return to absolute travel in one script.
      return `G91\nG1 ${call.args.axis.toUpperCase()}${mm(call.args.distance_mm)} F${call.args.feed}\nG90`
    case 'motors_off':
      return 'M84'
    case 'z_babystep':
      return `SET_GCODE_OFFSET Z_ADJUST=${mm(call.args.delta_mm)} MOVE=1`
    case 'set_factor':
      return `M220 S${call.args.speed_pct}\nM221 S${call.args.flow_pct}`
    default:
      throw new MotionRefusal('invalid')
  }
}

/** JSON-RPC call for a motion action; refusals throw MotionRefusal. */
export function moonrakerMotionCommand(
  action: MotionAction,
  args: Record<string, unknown>,
  state?: MotionState,
) {
  const script = buildMotionScript(action, args)
  refuseMotion(action, args, state)
  return { method: 'printer.gcode.script', params: { script } } as const
}
