import {
  ActiveSpool,
  ActiveSpools,
  type ActiveSpool as ActiveSpoolRow,
} from '@open3dfarmmanager/farm-protocol'
import type { z } from 'zod'
import type { ActiveSpoolAssignment } from './active-assignments.ts'
import { SpoolmanSpool } from './read.ts'

type Spool = z.infer<typeof SpoolmanSpool>

function colorHex(value: string | null): string | undefined {
  if (!value) return undefined
  const hex = value.length === 8 ? value.slice(0, 6) : value
  return /^[0-9A-Fa-f]{6}$/.test(hex) ? hex.toLowerCase() : undefined
}

function remainingPercent(spool: Spool): number | undefined {
  const remaining = spool.remaining_weight
  const initial = spool.initial_weight
  if (remaining === null || initial === null || initial <= 0) return undefined
  return Math.max(0, Math.min(100, (remaining / initial) * 100))
}

function fromSpool(slot: string, spool: Spool): ActiveSpoolRow {
  const material = spool.filament.material?.slice(0, 64) ?? undefined
  const name =
    spool.filament.name?.slice(0, 32) ??
    spool.location?.slice(0, 32) ??
    undefined
  const remaining = spool.remaining_weight
  const percent = remainingPercent(spool)
  const color = colorHex(spool.filament.color_hex)
  return ActiveSpool.parse({
    slot,
    spoolId: spool.id,
    ...(name ? { name } : {}),
    ...(material ? { material } : {}),
    ...(color ? { colorHex: color } : {}),
    ...(remaining !== null && Number.isSafeInteger(Math.trunc(remaining))
      ? { remainingGrams: Math.trunc(remaining) }
      : {}),
    ...(percent !== undefined ? { remainingPercent: percent } : {}),
  })
}

/**
 * Prefer Moonraker's active spool when present; otherwise use manual
 * per-tool assignments resolved against the Spoolman inventory mirror.
 */
export function resolveActiveSpools(input: {
  moonrakerSpoolId: number | null
  assignments: readonly ActiveSpoolAssignment[]
  inventory: readonly Spool[]
}): ActiveSpools {
  const byId = new Map(input.inventory.map((spool) => [spool.id, spool]))
  if (input.moonrakerSpoolId !== null) {
    const spool = byId.get(input.moonrakerSpoolId)
    return ActiveSpools.parse(spool ? [fromSpool('external', spool)] : [])
  }
  const rows: ActiveSpoolRow[] = []
  for (const assignment of input.assignments) {
    const spool = byId.get(assignment.spoolId)
    if (!spool) continue
    rows.push(fromSpool(assignment.slot, spool))
  }
  return ActiveSpools.parse(rows)
}
