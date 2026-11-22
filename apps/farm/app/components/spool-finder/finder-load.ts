import type { SpoolItem } from '../../utils/spool-library-types.ts'

export type FinderFarmList = {
  items: SpoolItem[]
  canWrite: boolean
}

/**
 * Fetches the spool list for `farmId`, then returns it only when the
 * selection still matches. A late response for a previous farm is discarded.
 */
export async function loadFinderSpools(
  farmId: string,
  current: () => boolean,
  fetch: (farmId: string) => Promise<FinderFarmList>,
): Promise<FinderFarmList | null> {
  const list = await fetch(farmId)
  if (!current()) return null
  return { items: list.items, canWrite: list.canWrite }
}
