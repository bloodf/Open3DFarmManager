import { DriverRefusalError } from '../control/driver-refusal.ts'
import type { ExtendedControlAction } from '../../../farm-protocol/src/control-actions.ts'
import type { ToolHeaters } from '../../../farm-protocol/src/state.ts'

export const U1_TOOL_OBJECTS = [
  'extruder',
  'extruder1',
  'extruder2',
  'extruder3',
] as const

// Maximums in the U1 Klipper printer.cfg. Firmware also enforces its configured limits.
export const U1_MAX_TOOL_C = 300
export const U1_MAX_BED_C = 100

export function snapmakerU1ToolHeaters(
  objects: readonly string[] | undefined,
): ToolHeaters {
  return ([0, 1, 2, 3] as const).flatMap((tool) =>
    objects?.includes(U1_TOOL_OBJECTS[tool])
      ? [{ tool, maxC: U1_MAX_TOOL_C }]
      : [],
  )
}

export function snapmakerU1Controls(
  objects: readonly string[] | undefined,
): readonly ExtendedControlAction[] {
  if (!objects?.includes('webhooks') || !objects.includes('print_stats'))
    return []
  const controls: ExtendedControlAction[] = ['pause', 'resume', 'cancel']
  if (objects.includes('extruder') || objects.includes('heater_bed'))
    controls.push('set_temperature')
  if (snapmakerU1ToolHeaters(objects).length)
    controls.push('set_tool_temperature')
  if (objects.includes('toolhead')) controls.push('home', 'jog')
  if (objects.includes('virtual_sdcard')) controls.push('start_print')
  controls.push('gcode') // Still requires the local per-assignment console switch.
  return controls
}

/**
 * Marker appended to the detected object list of a locally declared U1, like
 * the other capability markers.
 */
export const SNAPMAKER_U1_MARKER = 'openfarm:snapmaker-u1'

/** Typed refusal: the driver wrote nothing and says why. */
export class SnapmakerU1CommandRefused extends DriverRefusalError {
  constructor(command: string) {
    super('unsupported-action', `Snapmaker U1 command unavailable: ${command}`)
  }
}
