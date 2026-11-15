import type { SpoolmanSnapshot } from './spoolman-provider.ts'

type Spool = NonNullable<SpoolmanSnapshot['inventory']>['items'][number]

// Spoolman spool fields: https://github.com/Donkie/Spoolman/blob/master/docs/api.md
export function mapSpoolmanMaterial(spool: Spool) {
  const material = spool.filament.material?.slice(0, 64)
  const color = spool.filament.color_hex?.toUpperCase()
  const remaining = spool.remaining_weight
  const initial = spool.initial_weight
  return {
    slot: 'external',
    active: true,
    ...(material ? { materialType: material } : {}),
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
export async function getSpoolmanMaterials(
  getSpoolId: () => Promise<number | null>,
  snapshot: SpoolmanSnapshot,
) {
  if (snapshot.kind !== 'observed' || !snapshot.inventory) return undefined
  const id = await getSpoolId()
  if (!Number.isSafeInteger(id) || id === null || id <= 0) return undefined
  const spool = snapshot.inventory.items.find((item) => item.id === id)
  return spool ? [mapSpoolmanMaterial(spool)] : undefined
}
