import type { PrinterState } from '../../../../packages/farm-protocol/src/state.ts'

export function kobraXInputs(materials: PrinterState['materials']) {
  if (!materials?.some((material) => /^-1:[0-2]$/.test(material.slot)))
    return []
  return materials.flatMap((material) => {
    const match = /^(-1|0):([0-3])$/.exec(material.slot)
    if (!match || material.remainingPercent === 0) return []
    const slot = Number(match[2])
    if (match[1] === '-1' && slot > 2) return []
    const holder = match[1] === '-1'
    return [
      {
        id: holder ? slot : slot + 4,
        label: `${holder ? 'Suporte' : 'ACE'} ${slot + 1}${material.materialType ? ` — ${material.materialType}` : ''}`,
      },
    ]
  })
}

export function kobraXMapping(
  selections: readonly string[],
  count: number,
  inputs: ReturnType<typeof kobraXInputs>,
): number[] | undefined {
  if (!Number.isInteger(count) || count < 1 || count > 7) return undefined
  const selected = selections
    .slice(0, count)
    .map((selection) => inputs.find((input) => String(input.id) === selection))
  if (selected.length !== count || selected.some((input) => !input))
    return undefined
  return selected.flatMap((input) => (input ? [input.id] : []))
}
