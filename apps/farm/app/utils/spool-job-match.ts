// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Ranks the loaded spools for each filament a job asks for: material and colour
 * first (filament-match.ts decides what matches), then whether the weight left
 * is enough. A weight that is not known stays unknown: it is never read as zero
 * or as enough. Each requirement is ranked on its own; the demand of two
 * requirements on one spool is not added up.
 */
import {
  matchFilament,
  type FilamentMatchKind,
  type FilamentMatchResult,
  type FilamentRequirement,
  type FilamentSlot,
} from './filament-match.ts'
import { slotLabel } from './spool-features-format.ts'
import type { SlotAssignment } from './spool-features-types.ts'
import type { SpoolItem } from './spool-library-types.ts'
import { formatWeight } from './ui-format.ts'

export type JobFilamentRequirement = FilamentRequirement & {
  /** Grams the job needs of this filament, when the file says. */
  grams?: number | null | undefined
}

export type LoadedSlot = FilamentSlot & {
  /** Unique per slot; the last tie-breaker, so the order is stable. */
  key: string
  label: string
  remainingGrams?: number | null | undefined
}

/** `available`: filament is left, but the job does not say how much it needs. */
export type WeightCheck = 'enough' | 'available' | 'unknown' | 'short'

export interface RankedSlot<T extends LoadedSlot = LoadedSlot> {
  slot: T
  match: FilamentMatchResult
  weight: WeightCheck
  remainingGrams: number | null
  weightText: string
}

const MATCH_ORDER: Record<FilamentMatchKind, number> = {
  match: 0,
  'colour-unknown': 1,
  'colour-differs': 2,
  'material-unknown': 3,
  'material-differs': 4,
  'no-slot': 5,
}
const WEIGHT_ORDER: Record<WeightCheck, number> = {
  enough: 0,
  available: 0,
  unknown: 1,
  short: 2,
}

const grams = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null

function weigh(
  need: number | null,
  left: number | null,
): { weight: WeightCheck; weightText: string } {
  if (left === null)
    return { weight: 'unknown', weightText: 'Peso restante não informado.' }
  const has = formatWeight(left)
  if (left === 0)
    return { weight: 'short', weightText: 'Bobina sem filamento restante.' }
  if (need === null)
    return {
      weight: 'available',
      weightText: `Restam ${has}. O arquivo não informa quanto é preciso.`,
    }
  return left >= need
    ? {
        weight: 'enough',
        weightText: `Restam ${has}, o suficiente para ${formatWeight(need)}.`,
      }
    : {
        weight: 'short',
        weightText: `Restam ${has}, menos que os ${formatWeight(need)} pedidos.`,
      }
}

export function rankSlots<T extends LoadedSlot>(
  required: JobFilamentRequirement,
  slots: readonly T[],
): RankedSlot<T>[] {
  const stated = grams(required.grams)
  const need = stated !== null && stated > 0 ? stated : null
  return slots
    .map((slot): RankedSlot<T> => {
      const remainingGrams = grams(slot.remainingGrams)
      return {
        slot,
        match: matchFilament(required, slot),
        remainingGrams,
        ...weigh(need, remainingGrams),
      }
    })
    .sort(
      (a, b) =>
        MATCH_ORDER[a.match.kind] - MATCH_ORDER[b.match.kind] ||
        WEIGHT_ORDER[a.weight] - WEIGHT_ORDER[b.weight] ||
        (b.remainingGrams ?? -1) - (a.remainingGrams ?? -1) ||
        a.slot.key.localeCompare(b.slot.key),
    )
}

/** One ranking per filament of the job, in the file's order. */
export function rankSlotsForJob<T extends LoadedSlot>(
  requirements: readonly JobFilamentRequirement[],
  slots: readonly T[],
): { required: JobFilamentRequirement; candidates: RankedSlot<T>[] }[] {
  return requirements.map((required) => ({
    required,
    candidates: rankSlots(required, slots),
  }))
}

export type LoadedSpoolSlot = LoadedSlot & {
  printerId: string
  spool: SpoolItem
}

/**
 * The library spools bound to a slot right now. Pass one farm's assignments and
 * spools; a binding whose spool is missing or archived is left out.
 */
export function loadedSpoolSlots(
  assignments: readonly SlotAssignment[],
  spools: readonly SpoolItem[],
): LoadedSpoolSlot[] {
  const byId = new Map(
    spools
      .filter((spool) => !spool.archived)
      .map((spool) => [Number(spool.id), spool]),
  )
  return assignments.flatMap((assignment) => {
    const spool = byId.get(Number(assignment.spoolId))
    if (assignment.unassignedAt !== null || !spool) return []
    return [
      {
        key: `${assignment.printerId}:${assignment.slotKind}:${assignment.slotIndex}`,
        label: slotLabel(assignment.slotKind, assignment.slotIndex),
        printerId: assignment.printerId,
        spool,
        materialType: spool.filament.material,
        colorHex: spool.filament.color_hex,
        remainingGrams: spool.remaining_weight ?? null,
      },
    ]
  })
}
