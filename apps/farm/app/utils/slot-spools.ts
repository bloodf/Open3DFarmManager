// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PrinterState } from '../../../../packages/farm-protocol/src/state.ts'
import { resolveSpoolLevel, type SpoolLevel } from './spool-level.ts'
import type { SlotAssignment, SlotKind } from './spool-features-types.ts'
import type { SpoolItem } from './spool-library-types.ts'

import type { SpoolSummary } from '../../../../packages/farm-protocol/src/inventory.ts'
import type { ActiveSpool } from '../../../../packages/farm-protocol/src/status.ts'
import {
  spoolInventoryStale,
  type FarmRow,
  type FarmSpoolObservation,
} from './farm-view.ts'
import { safeReadStored } from './spool-form-state.ts'

export function activeSpoolStorageKey(farmId: string, printerKey: string) {
  return `openfarm.active-spool.${farmId}.${printerKey}`
}

export function readActiveSpoolAssignments(
  farmId: string,
  printerKey: string,
): Record<string, number> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = safeReadStored(
      window.localStorage,
      activeSpoolStorageKey(farmId, printerKey),
    )
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([slot, value]) =>
          slot.length > 0 &&
          slot.length <= 32 &&
          typeof value === 'number' &&
          Number.isSafeInteger(value) &&
          value > 0,
      ),
    )
  } catch {
    return {}
  }
}

export function moonrakerManagesSpool(row: FarmRow) {
  return (
    row.observation?.state.materials?.some(
      (material) => material.slot === 'external' && material.active === true,
    ) ?? false
  )
}

export function activeSlotSpools({
  farmId,
  row,
  inventory,
  now,
  assignments,
}: {
  farmId: string
  row: FarmRow
  inventory: readonly FarmSpoolObservation[]
  now: { wall: number; mono: number }
  assignments?: Readonly<Record<string, number>>
}): ActiveSpool[] {
  if (
    row.connection !== 'authenticated' ||
    !row.observation ||
    row.observation.historical ||
    moonrakerManagesSpool(row)
  )
    return []

  const current = inventory.find(
    (item) => item.agentId === row.assignment.agentId,
  )
  const byId = new Map<number, SpoolSummary>()
  if (current?.inventory?.serviceId && !spoolInventoryStale(current, now)) {
    for (const spool of current.inventory.spools)
      if (spool.spoolId !== undefined) byId.set(spool.spoolId, spool)
  }
  return Object.entries(
    assignments ??
      readActiveSpoolAssignments(farmId, row.assignment.printerKey),
  ).map(([slot, spoolId]) => {
    const spool = byId.get(spoolId)
    return {
      slot,
      spoolId,
      name: spool?.name ?? undefined,
      material: spool?.material ?? undefined,
      colorHex: spool?.colorHex ?? undefined,
      remainingPercent: spool?.remainingPercent,
    }
  })
}

/**
 * Weights of the Spoolman spool verified as bound to a slot, in grams. A
 * binding is only passed when the spool is known to sit in that slot; a slot
 * without one is read from what the printer itself reports.
 */
export interface SlotBinding {
  remainingGrams?: number | null
  initialGrams?: number | null
}

/** What one printer slot or tray needs to be drawn as a spool. */
export interface FarmSlotView {
  key: string
  /** The slot's identity in pt-BR, for example "AMS 1, bandeja 3". */
  label: string
  material: string
  /** `#RRGGBB` reported for the filament, or null: never a guessed colour. */
  color: string | null
  printerPercent: number | null
  spoolmanPercent: number | null
  spoolmanRemainingWeight: number | null
  spoolmanInitialWeight: number | null
  active: boolean
  /** Running out: at or below 15 % of a known level. */
  low: boolean
  level: SpoolLevel
}

const LOW_FRACTION = 0.15

/**
 * Global tray index of an AMS slot id: unit * 4 + slot (0-15) for the four-slot
 * units, and the unit id (128-135) for the single-slot AMS HT units.
 */
export function amsTrayIndex(slot: string): number | undefined {
  const ams = /^ams:([0-3]):([0-3])$/.exec(slot)
  if (ams) return Number(ams[1]) * 4 + Number(ams[2])
  const ht = /^ams:(12[89]|13[0-5]):0$/.exec(slot)
  return ht ? Number(ht[1]) : undefined
}

/** Index of a material station tray (`ifs:0` to `ifs:3`, Flashforge AD5X). */
export function stationTrayIndex(slot: string): number | undefined {
  const station = /^ifs:([0-3])$/.exec(slot)
  return station ? Number(station[1]) : undefined
}

/** The slot name as shown to people: AMS trays, ACE slots, holders, external. */
export function farmSlotLabel(slot: string): string {
  const tray = amsTrayIndex(slot)
  if (tray !== undefined)
    return tray >= 128
      ? `AMS HT ${tray - 127}`
      : `AMS ${Math.floor(tray / 4) + 1}, bandeja ${(tray % 4) + 1}`
  const station = stationTrayIndex(slot)
  if (station !== undefined) return `Compartimento ${station + 1}`
  // The second external holder of a dual-extruder Bambu printer.
  if (slot === 'external:254') return 'Bobina externa 2'
  const kobra = /^(-1|0):([0-3])$/.exec(slot)
  if (kobra)
    return `${kobra[1] === '-1' ? 'Suporte' : 'ACE'} ${Number(kobra[2]) + 1}`
  return slot === 'external' ? 'Bobina externa' : slot
}

export function farmSlotViews(
  materials: PrinterState['materials'],
  bindings?: Readonly<Record<string, SlotBinding | undefined>>,
  activeSpools?: readonly ActiveSpool[],
): FarmSlotView[] | undefined {
  if (!materials && !activeSpools?.length) return undefined
  const bySlot = new Map(
    materials?.map((material) => [material.slot, material]),
  )
  const assigned = new Map(activeSpools?.map((spool) => [spool.slot, spool]))
  const slots = new Set([...bySlot.keys(), ...assigned.keys()])
  return Array.from(slots, (slot) => {
    const material = bySlot.get(slot)
    const spool = assigned.get(slot)
    const binding = bindings?.[slot]
    const spoolmanRemainingWeight = binding?.remainingGrams ?? null
    const spoolmanInitialWeight = binding?.initialGrams ?? null
    const printerPercent = material?.remainingPercent ?? null
    const spoolmanPercent = spool?.remainingPercent ?? null
    const level = resolveSpoolLevel({
      spoolmanRemainingWeight,
      spoolmanInitialWeight,
      spoolmanPercent,
      printerPercent,
    })
    const rgb = (
      binding ? material?.colorHex : (spool?.colorHex ?? material?.colorHex)
    )?.slice(0, 6)
    return {
      key: slot,
      label: farmSlotLabel(slot),
      material:
        material?.materialType ||
        spool?.material ||
        spool?.name ||
        'Material desconhecido',
      color: rgb && /^[0-9A-Fa-f]{6}$/.test(rgb) ? `#${rgb}` : null,
      printerPercent,
      spoolmanPercent,
      spoolmanRemainingWeight,
      spoolmanInitialWeight,
      active: material?.active === true,
      low: level.kind === 'known' && level.fraction <= LOW_FRACTION,
      level,
    }
  })
}

type SlotBindingKey = `${SlotKind}:${number}`
export type SlotBindingIndex = ReadonlyMap<
  string,
  Map<SlotBindingKey, SlotBinding>
>

export function slotBindingKey(slot: string): SlotBindingKey {
  const tray = amsTrayIndex(slot)
  if (tray !== undefined) return `ams:${tray}`
  const ace = /^(\d+):([0-3])$/.exec(slot)
  if (ace) return `ams:${Number(ace[1]) * 4 + Number(ace[2])}`
  const tool = /^(?:t|tool|extruder|toolhead)[-_:]?(\d{1,4})$/i.exec(slot)
  if (tool) return `toolhead:${Number(tool[1])}`
  const holder = /^-1:([0-3])$/.exec(slot)
  if (holder) return `printer:${Number(holder[1])}`
  if (slot === 'external:254') return 'printer:1'
  return slot === 'external' ? 'printer:0' : 'printer:-1'
}

export function verifiedSlotBindings(
  assignments: readonly SlotAssignment[],
  spools: readonly SpoolItem[],
): SlotBindingIndex {
  const byId = new Map(
    spools
      .filter((spool) => !spool.archived)
      .map((spool) => [Number(spool.id), spool]),
  )
  const index = new Map<string, Map<SlotBindingKey, SlotBinding>>()
  for (const assignment of assignments) {
    if (assignment.unassignedAt !== null) continue
    const spool = byId.get(Number(assignment.spoolId))
    if (!spool) continue
    const slots =
      index.get(assignment.printerId) ?? new Map<SlotBindingKey, SlotBinding>()
    slots.set(`${assignment.slotKind}:${assignment.slotIndex}`, {
      remainingGrams: spool.remaining_weight ?? null,
      initialGrams: spool.initial_weight ?? spool.filament.weight ?? null,
    })
    index.set(assignment.printerId, slots)
  }
  return index
}
