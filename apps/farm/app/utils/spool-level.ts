// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * How much filament is left on a spool, and where that number came from.
 *
 * Order of trust: Spoolman's remaining/initial weight first, then the
 * percentage the printer reports for its own slot, otherwise unknown. A value
 * that cannot be a real amount (not a number, negative, over 100 %, a zero
 * initial weight) is never repaired into a level: it is skipped, and when
 * nothing usable remains the level is `unknown`.
 */
export type SpoolLevel =
  | { kind: 'known'; fraction: number; source: 'spoolman' | 'printer' }
  | { kind: 'unknown' }

export interface SpoolLevelInput {
  /** Spoolman `remaining_weight`, in grams. */
  spoolmanRemainingWeight?: number | null
  /** Spoolman `initial_weight` of the spool or its filament, in grams. */
  spoolmanInitialWeight?: number | null
  /** Percentage the printer reports for the slot, 0 to 100. */
  printerPercent?: number | null
}

const unknown: SpoolLevel = { kind: 'unknown' }

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function resolveSpoolLevel(input: SpoolLevelInput): SpoolLevel {
  const { spoolmanRemainingWeight: left, spoolmanInitialWeight: initial } =
    input
  // Zero grams left is a real, empty spool. Negative grams are not a level.
  // A spool weighed slightly above its nominal weight is full, not "108 %".
  if (finite(left) && finite(initial) && initial > 0 && left >= 0) {
    return {
      kind: 'known',
      fraction: Math.min(1, left / initial),
      source: 'spoolman',
    }
  }
  const percent = input.printerPercent
  // Printers send -1 or 255 for "no reading": outside 0..100 is not a level.
  if (finite(percent) && percent >= 0 && percent <= 100) {
    return { kind: 'known', fraction: percent / 100, source: 'printer' }
  }
  return unknown
}
