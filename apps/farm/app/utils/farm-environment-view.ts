import type { PrinterState } from '../../../../packages/farm-protocol/src/state.ts'

export interface FarmFanItem {
  id: 'part' | 'aux' | 'chamber'
  label: string
  percent: number
  percentLabel: string
}

export interface FarmLightItem {
  id: 'chamber'
  label: string
  on: boolean
  statusLabel: string
}

export interface FarmEnvironmentView {
  fans: FarmFanItem[]
  light?: FarmLightItem
}

export function farmEnvironmentView(
  fans: PrinterState['fans'],
  light: PrinterState['light'],
): FarmEnvironmentView | undefined {
  const fanItems: FarmFanItem[] = []

  if (fans?.part !== undefined) {
    fanItems.push({
      id: 'part',
      label: 'Ventilador da peça',
      percent: fans.part,
      percentLabel: `${fans.part}%`,
    })
  }

  if (fans?.aux !== undefined) {
    fanItems.push({
      id: 'aux',
      label: 'Ventilador auxiliar',
      percent: fans.aux,
      percentLabel: `${fans.aux}%`,
    })
  }

  if (fans?.chamber !== undefined) {
    fanItems.push({
      id: 'chamber',
      label: 'Ventilador da câmara',
      percent: fans.chamber,
      percentLabel: `${fans.chamber}%`,
    })
  }

  let lightItem: FarmLightItem | undefined
  if (light?.chamber !== undefined) {
    lightItem = {
      id: 'chamber',
      label: 'Luz da câmara',
      on: light.chamber,
      statusLabel: light.chamber ? 'Ligada' : 'Desligada',
    }
  }

  if (fanItems.length === 0 && lightItem === undefined) {
    return undefined
  }

  return {
    fans: fanItems,
    ...(lightItem !== undefined ? { light: lightItem } : {}),
  }
}
