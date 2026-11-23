import type { FarmAlert } from './farm-alerts.ts'
import type { FarmRow } from './farm-view.ts'

/** The detail page of a printer, the target of every wall card and table row. */
export function printerDetailHref(printerKey: string, farmId?: string): string {
  return `/impressoras/${encodeURIComponent(printerKey)}${farmId ? `?farm=${encodeURIComponent(farmId)}` : ''}`
}

/**
 * What `PrinterWallCard` shows for a farm row: the display name (the key when
 * there is none), group, location and the observation. Targets and thumbnail
 * are not part of the status feed, so they stay absent instead of invented.
 */
export function wallCardProps(
  row: FarmRow,
  alerts: readonly FarmAlert[],
  farmId?: string,
) {
  const { assignment, observation } = row
  return {
    name: assignment.displayName || assignment.printerKey,
    detailHref: printerDetailHref(assignment.printerKey, farmId),
    group: assignment.groupName || undefined,
    location: assignment.location || undefined,
    observation,
    alerts,
  }
}
