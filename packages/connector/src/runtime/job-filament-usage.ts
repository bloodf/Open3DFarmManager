import type {
  FilamentUsage,
  PrinterState,
} from '@open3dfarmmanager/farm-protocol'

type Material = NonNullable<PrinterState['materials']>[number]

/** Convert Moonraker's total filament length using the one selected spool. */
export function moonrakerFilamentUsage(
  millimetres: number,
  materials: readonly Material[] | undefined,
): FilamentUsage {
  const active = materials?.filter((material) => material.active) ?? []
  const material =
    active.length === 1
      ? active[0]
      : active.length === 0 && materials?.length === 1
        ? materials[0]
        : undefined
  const diameter = material?.filamentDiameterMm
  const density = material?.filamentDensityGramsPerCm3
  const grams =
    diameter !== undefined && density !== undefined
      ? (millimetres * Math.PI * (diameter / 2) ** 2 * density) / 1000
      : undefined
  return {
    tool: material?.slot ?? 'unknown',
    millimetres,
    ...(grams === undefined || !Number.isFinite(grams) ? {} : { grams }),
  }
}
