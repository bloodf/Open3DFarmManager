// SPDX-License-Identifier: AGPL-3.0-or-later
import { MAX_SPOOL_IDS } from '../../common/spool-ids.ts'
import { verifiedSlotBindings, type SlotBindingIndex } from './slot-spools.ts'
import type { SlotAssignment } from './spool-features-types.ts'
import type {
  SpoolItem,
  SpoolLibraryListResponse,
} from './spool-library-types.ts'

/**
 * Verified bindings for the active slot assignments. Reads only the assigned
 * spools, in bounded batches, never the whole library.
 */
export async function loadSlotBindings(
  farmId: string,
  signal: AbortSignal,
): Promise<SlotBindingIndex> {
  const api = `/api/farms/${farmId}/spool-library`
  const options = { retry: 0, timeout: 15_000, signal }
  const { assignments } = await $fetch<{ assignments: SlotAssignment[] }>(
    `${api}/slots`,
    options,
  )
  const ids = [
    ...new Set(
      assignments
        .filter((assignment) => assignment.unassignedAt === null)
        .map((assignment) => Number(assignment.spoolId)),
    ),
  ].sort((a, b) => a - b)
  const spools: SpoolItem[] = []
  for (let start = 0; start < ids.length; start += MAX_SPOOL_IDS) {
    const { items } = await $fetch<SpoolLibraryListResponse<SpoolItem>>(
      `${api}/spools`,
      {
        ...options,
        query: { ids: ids.slice(start, start + MAX_SPOOL_IDS).join(',') },
      },
    )
    spools.push(...items)
  }
  return verifiedSlotBindings(assignments, spools)
}
