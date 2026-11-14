import { describe, expect, it } from 'vitest'
import { farmMaterialsView } from '../../apps/farm/app/utils/farm-materials-view.ts'

describe('farmMaterialsView', () => {
  it('keeps absent materials hidden and an empty list visible', () => {
    expect(farmMaterialsView(undefined)).toBeUndefined()
    expect(farmMaterialsView([])).toEqual([])
  })
  it('labels trays, color, remaining and active state', () => {
    expect(
      farmMaterialsView([
        {
          slot: 'ams:0:2',
          materialType: 'PLA',
          colorHex: 'FF0000FF',
          remainingPercent: 0,
          active: true,
        },
        { slot: 'external' },
      ]),
    ).toEqual([
      {
        slot: 'AMS 1, bandeja 3',
        material: 'PLA',
        color: '#FF0000FF',
        colorLabel: 'Cor #FF0000FF',
        remaining: '0%',
        active: true,
      },
      {
        slot: 'Bobina externa',
        material: 'Material desconhecido',
        color: undefined,
        colorLabel: 'Cor desconhecida',
        remaining: 'desconhecido',
        active: false,
      },
    ])
  })
})
