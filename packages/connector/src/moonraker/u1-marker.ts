export type SnapmakerU1UnsupportedReason =
  'tool-command-not-implemented' | 'not-hardware-qualified'

/** Tool-aware commands the Moonraker adapter has no builder for. */
export const TOOL_COMMANDS = ['select_tool', 'set_tool_temperature'] as const

/**
 * Marker appended to the detected object list of a locally declared U1, like
 * the other capability markers. Commands built against it are refused.
 */
export const SNAPMAKER_U1_MARKER = 'openfarm:snapmaker-u1'

/** Typed refusal: the driver wrote nothing and says why. */
export class SnapmakerU1CommandRefused extends Error {
  readonly refusal = 'unsupported-action' as const
  readonly reason: SnapmakerU1UnsupportedReason
  constructor(command: string) {
    const reason: SnapmakerU1UnsupportedReason = (
      TOOL_COMMANDS as readonly string[]
    ).includes(command)
      ? 'tool-command-not-implemented'
      : 'not-hardware-qualified'
    super(`Snapmaker U1 command refused: ${reason}`)
    this.reason = reason
  }
}
