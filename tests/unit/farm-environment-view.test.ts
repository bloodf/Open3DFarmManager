import { describe, expect, it } from 'vitest'
import { farmEnvironmentView } from '../../apps/farm/app/utils/farm-environment-view.ts'

describe('farmEnvironmentView', () => {
  it('returns undefined when fans and light are undefined', () => {
    expect(farmEnvironmentView(undefined, undefined)).toBeUndefined()
  })

  it('returns undefined when fans and light are empty objects without known fields', () => {
    expect(farmEnvironmentView({}, {})).toBeUndefined()
  })

  it('formats all fan percentages and chamber light when present', () => {
    const view = farmEnvironmentView(
      { part: 100, aux: 50, chamber: 0 },
      { chamber: true },
    )
    expect(view).toEqual({
      fans: [
        {
          id: 'part',
          label: 'Ventilador da peça',
          percent: 100,
          percentLabel: '100%',
        },
        {
          id: 'aux',
          label: 'Ventilador auxiliar',
          percent: 50,
          percentLabel: '50%',
        },
        {
          id: 'chamber',
          label: 'Ventilador da câmara',
          percent: 0,
          percentLabel: '0%',
        },
      ],
      light: {
        id: 'chamber',
        label: 'Luz da câmara',
        on: true,
        statusLabel: 'Ligada',
      },
    })
  })

  it('formats light when chamber light is off', () => {
    const view = farmEnvironmentView(undefined, { chamber: false })
    expect(view).toEqual({
      fans: [],
      light: {
        id: 'chamber',
        label: 'Luz da câmara',
        on: false,
        statusLabel: 'Desligada',
      },
    })
  })

  it('formats only available fans when partial fans exist without light', () => {
    const view = farmEnvironmentView({ part: 75 }, undefined)
    expect(view).toEqual({
      fans: [
        {
          id: 'part',
          label: 'Ventilador da peça',
          percent: 75,
          percentLabel: '75%',
        },
      ],
    })
    expect(view?.light).toBeUndefined()
  })

  it('handles 0% fan speeds correctly as active defined values', () => {
    const view = farmEnvironmentView({ aux: 0 }, undefined)
    expect(view).toEqual({
      fans: [
        {
          id: 'aux',
          label: 'Ventilador auxiliar',
          percent: 0,
          percentLabel: '0%',
        },
      ],
    })
  })
})
