import { ControlArguments } from '../../../farm-protocol/src/control-actions.ts'
export const DEFAULT_CONTROL_LIMITS = Object.freeze({
  extruder: 300,
  bed: 120,
  chamber: 65,
})
export type ControlLimits = Readonly<{
  extruder: number
  bed: number
  chamber: number
}>
export const CONTROL_SPEED_PERCENT = Object.freeze({
  silent: 50,
  standard: 100,
  sport: 124,
  ludicrous: 166,
})
export function controlWithinLimits(
  action: unknown,
  args: unknown,
  limits: ControlLimits = DEFAULT_CONTROL_LIMITS,
): boolean {
  const parsed = ControlArguments.safeParse({ action, args })
  if (!parsed.success) return false
  if (
    parsed.data.action !== 'set_temperature' &&
    parsed.data.action !== 'set_tool_temperature'
  )
    return true
  const maximum =
    parsed.data.action === 'set_tool_temperature'
      ? limits.extruder
      : limits[parsed.data.args.heater]
  return (
    Number.isFinite(maximum) &&
    maximum >= 0 &&
    parsed.data.args.target_c <= maximum
  )
}
