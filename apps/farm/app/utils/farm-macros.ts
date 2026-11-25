import { ControlArguments } from '../../../../packages/farm-protocol/src/control-actions.ts'
import { amsTrayIndex, farmSlotLabel } from './slot-spools.ts'
import type { PrinterState } from '../../../../packages/farm-protocol/src/state.ts'

export function macroActions(state: PrinterState | undefined) {
  const controls = state?.controls ?? []
  return {
    macros: controls.includes('run_macro') ? (state?.macros ?? []) : [],
    load: controls.includes('load_filament'),
    unload: controls.includes('unload_filament'),
  }
}

export function macroArgs(state: PrinterState | undefined, name: string) {
  const args = { name }
  return macroActions(state).macros.includes(name) &&
    ControlArguments.safeParse({ action: 'run_macro', args }).success
    ? args
    : undefined
}

/**
 * Trays the Connector can load by number. External holders have no load target,
 * so they are not offered.
 */
export function filamentTrays(state: PrinterState | undefined) {
  return (state?.materials ?? []).flatMap((material) => {
    const id = amsTrayIndex(material.slot)
    if (id === undefined) return []
    const name = id >= 128 ? farmSlotLabel(material.slot) : material.slot
    return [
      {
        id,
        label: `${name}${material.materialType ? ` — ${material.materialType}` : ''}`,
        material,
      },
    ]
  })
}
