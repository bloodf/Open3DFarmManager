import type { PrinterState } from '../../../../packages/farm-protocol/src/state.ts'

export function farmMaterialsView(materials: PrinterState['materials']) {
  return materials?.map((material) => {
    const match = /^ams:([0-3]):([0-3])$/.exec(material.slot)
    return {
      slot: match
        ? `AMS ${Number(match[1]) + 1}, bandeja ${Number(match[2]) + 1}`
        : material.slot === 'external'
          ? 'Bobina externa'
          : material.slot,
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
