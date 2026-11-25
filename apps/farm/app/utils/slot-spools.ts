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
