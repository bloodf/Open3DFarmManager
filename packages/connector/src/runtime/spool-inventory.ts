import {
  MAX_INVENTORY_SPOOLS,
  SpoolInventory,
  SpoolSummary,
} from '../../../farm-protocol/src/inventory.ts'
import type { SpoolmanSnapshot } from './spoolman-provider.ts'

/** Spoolman observations older than this are shown as stale. */
const STALE_MS = 30_000

function clip(value: string | null, max: number): string | null {
  if (value === null) return null
  const text = value.slice(0, max)
  // Never leave half a surrogate pair at the cut.
  return /[\uD800-\uDBFF]$/.test(text) ? text.slice(0, -1) : text
}

/** Bounded, display-only projection of the maintained Spoolman mirror.
 * Active spools sort first so the cap never hides them behind archived ones.
 */
export function summarizeSpoolman(snapshot: SpoolmanSnapshot) {
  if (snapshot.inventory === null || snapshot.ageMs === null) return null
  const items = [...snapshot.inventory.items].sort(
    (a, b) => Number(a.archived) - Number(b.archived) || a.id - b.id,
  )
  const spools = items.slice(0, MAX_INVENTORY_SPOOLS).map((item) =>
    SpoolSummary.parse({
      name: clip(item.filament.name, 32),
      material: clip(item.filament.material, 16),
      colorHex: item.filament.color_hex?.slice(0, 6).toLowerCase() ?? null,
      remainingGrams:
        item.remaining_weight === null
          ? null
          : Math.max(
              -1_000_000,
              Math.min(1_000_000, Math.round(item.remaining_weight)),
            ),
      location: clip(item.location, 32),
      archived: item.archived,
    }),
  )
  return Object.freeze({
    spools: Object.freeze(spools),
    total: Math.min(10_000, items.length),
    ageMs: snapshot.ageMs,
    kind: snapshot.kind,
  })
}
export type SpoolSummaryState = NonNullable<
  ReturnType<typeof summarizeSpoolman>
>

/** Age advances with the Connector monotonic clock between provider updates. */
export function inventoryAt(
  state: SpoolSummaryState,
  elapsedMs: number,
  wallNow: number,
  count = state.spools.length,
): SpoolInventory {
  const ageMs = state.ageMs + Math.max(0, elapsedMs)
  return SpoolInventory.parse({
    observedAt: Math.max(0, Math.floor(wallNow - ageMs)),
    stale: state.kind !== 'observed' || ageMs >= STALE_MS,
    total: state.total,
    spools: state.spools.slice(0, count),
  })
}
