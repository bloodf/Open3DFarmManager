import { ControlArguments } from '../../../../packages/farm-protocol/src/control-actions.ts'
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

export function filamentTrays(state: PrinterState | undefined) {
  return (state?.materials ?? []).flatMap((material) => {
    const match = /^ams:([0-3]):([0-3])$/.exec(material.slot)
    return match
      ? [
          {
            id: Number(match[1]) * 4 + Number(match[2]),
            label: `${material.slot}${material.materialType ? ` — ${material.materialType}` : ''}`,
          },
        ]
      : []
  })
}
