// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PrinterState } from '../../../../packages/farm-protocol/src/state.ts'
import { resolveSpoolLevel, type SpoolLevel } from './spool-level.ts'

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
  spoolmanRemainingWeight: number | null
  spoolmanInitialWeight: number | null
  active: boolean
  /** Running out: at or below 15 % of a known level. */
  low: boolean
  level: SpoolLevel
}

const LOW_FRACTION = 0.15

/** The slot name as shown to people: AMS trays, ACE slots, holders, external. */
export function farmSlotLabel(slot: string): string {
  const ams = /^ams:([0-3]):([0-3])$/.exec(slot)
  if (ams) return `AMS ${Number(ams[1]) + 1}, bandeja ${Number(ams[2]) + 1}`
  const kobra = /^(-1|0):([0-3])$/.exec(slot)
  if (kobra)
    return `${kobra[1] === '-1' ? 'Suporte' : 'ACE'} ${Number(kobra[2]) + 1}`
  return slot === 'external' ? 'Bobina externa' : slot
}

export function farmSlotViews(
  materials: PrinterState['materials'],
  bindings?: Readonly<Record<string, SlotBinding | undefined>>,
): FarmSlotView[] | undefined {
  return materials?.map((material) => {
    const binding = bindings?.[material.slot]
    const spoolmanRemainingWeight = binding?.remainingGrams ?? null
    const spoolmanInitialWeight = binding?.initialGrams ?? null
    const printerPercent = material.remainingPercent ?? null
    const level = resolveSpoolLevel({
      spoolmanRemainingWeight,
      spoolmanInitialWeight,
      printerPercent,
    })
    const rgb = material.colorHex?.slice(0, 6)
    return {
      key: material.slot,
      label: farmSlotLabel(material.slot),
      material: material.materialType || 'Material desconhecido',
      color: rgb && /^[0-9A-Fa-f]{6}$/.test(rgb) ? `#${rgb}` : null,
      printerPercent,
      spoolmanRemainingWeight,
      spoolmanInitialWeight,
      active: material.active === true,
      low: level.kind === 'known' && level.fraction <= LOW_FRACTION,
      level,
    }
  })
}
