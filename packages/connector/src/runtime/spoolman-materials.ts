import { boundPrinterString } from '@open3dfarmmanager/farm-protocol'
import type { SpoolmanSnapshot } from './spoolman-provider.ts'
import type { ActiveSpoolAssignment } from '../spoolman/active-assignments.ts'

type Spool = NonNullable<SpoolmanSnapshot['inventory']>['items'][number]

// Spoolman spool fields: https://github.com/Donkie/Spoolman/blob/master/docs/api.md
export function mapSpoolmanMaterial(spool: Spool, slot = 'external') {
  const material = spool.filament.material
    ? boundPrinterString(spool.filament.material, 64)
    : undefined
  const color = spool.filament.color_hex?.toUpperCase()
  const remaining = spool.remaining_weight
  const initial = spool.initial_weight
  return {
    slot,
    active: true,
    ...(material ? { materialType: material } : {}),
    ...(spool.filament.diameter === null
      ? {}
      : { filamentDiameterMm: spool.filament.diameter }),
    ...(spool.filament.density === null
      ? {}
      : { filamentDensityGramsPerCm3: spool.filament.density }),
    ...(color ? { colorHex: color.length === 6 ? `${color}FF` : color } : {}),
    ...(remaining !== null && initial !== null && initial > 0
      ? {
          remainingPercent: Math.max(
            0,
            Math.min(100, (remaining / initial) * 100),
          ),
        }
      : {}),
  }
}

// Moonraker's server.spoolman.get_spool_id returns the printer's active spool.
// https://moonraker.readthedocs.io/en/latest/external_api/spoolman/
// When Moonraker has no active spool, fall back to manual per-tool assignments.
export async function getSpoolmanMaterials(
  getSpoolId: () => Promise<number | null>,
  snapshot: SpoolmanSnapshot,
  assignments: readonly ActiveSpoolAssignment[] = [],
) {
  if (snapshot.kind !== 'observed' || !snapshot.inventory) return undefined
  const id = await getSpoolId()
  if (id !== null && Number.isSafeInteger(id) && id > 0) {
    const spool = snapshot.inventory.items.find((item) => item.id === id)
    return spool ? [mapSpoolmanMaterial(spool)] : undefined
  }
  if (!assignments.length) return undefined
  const materials = []
  for (const assignment of assignments) {
    const spool = snapshot.inventory.items.find(
      (item) => item.id === assignment.spoolId,
    )
    if (spool) materials.push(mapSpoolmanMaterial(spool, assignment.slot))
  }
  return materials.length ? materials : undefined
}
