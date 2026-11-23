import { describe, expect, it } from 'vitest'
import { syncMotionFactors } from '../../apps/farm/app/utils/motion-factors.ts'

describe('syncMotionFactors', () => {
  it('follows live factors until each field is edited', () => {
    const edited = { speed: false, flow: false }
    expect(syncMotionFactors(edited, 120, 90)).toEqual({
      speed: '120',
      flow: '90',
    })
    edited.speed = true
    expect(
      syncMotionFactors(edited, 130, 95, { speed: '120', flow: '90' }),
    ).toEqual({ speed: '120', flow: '95' })
  })
})
