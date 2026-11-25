import type { PrinterState } from '../../../../packages/farm-protocol/src/state.ts'

import { farmSlotLabel } from './slot-spools.ts'

export function farmMaterialsView(materials: PrinterState['materials']) {
  return materials?.map((material) => {
    return {
      slot: farmSlotLabel(material.slot),
      material: material.materialType || 'Material desconhecido',
      color: material.colorHex ? `#${material.colorHex}` : undefined,
      colorLabel: material.colorHex
        ? `Cor #${material.colorHex}`
        : 'Cor desconhecida',
      ...(material.remainingPercent !== undefined
        ? { remainingPercent: material.remainingPercent }
        : {}),
      remaining:
        material.remainingPercent === undefined
          ? 'desconhecido'
          : `${material.remainingPercent}%`,
      active: material.active === true,
    }
  })
}
