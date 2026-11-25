// SPDX-License-Identifier: AGPL-3.0-or-later
import { verifiedSlotBindings, type SlotBindingIndex } from './slot-spools.ts'
import type { SlotAssignment } from './spool-features-types.ts'
import type { SpoolItem } from './spool-library-types.ts'

/** Most spool requests in flight at once. */
export const SPOOL_REQUEST_CONCURRENCY = 6

/**
 * Verified bindings for the active slot assignments. Reads each assigned spool
 * by id, never the whole library.
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
  ]
  const spools: SpoolItem[] = []
  for (let start = 0; start < ids.length; start += SPOOL_REQUEST_CONCURRENCY) {
    const batch = await Promise.all(
      ids.slice(start, start + SPOOL_REQUEST_CONCURRENCY).map(async (id) => {
        try {
          const { item } = await $fetch<{ item: SpoolItem }>(
            `${api}/spools/${id}`,
            options,
          )
          return [item]
        } catch (error) {
          // A missing spool must not hide the other slots' bindings.
          if ((error as { statusCode?: unknown }).statusCode === 404) return []
          throw error
        }
      }),
    )
    spools.push(...batch.flat())
  }
  return verifiedSlotBindings(assignments, spools)
}
