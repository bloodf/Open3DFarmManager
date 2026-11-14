import { describe, expect, it } from 'vitest'
import {
  farmJobView,
  formatJobTime,
} from '../../apps/farm/app/utils/farm-job-view.ts'

describe('farm job view', () => {
  it('formats supplied job details', () => {
    expect(
      farmJobView({
        printerKey: 'p',
        state: 'printing',
        observedAt: 0,
        progress: 0.5,
        filename: 'part.gcode',
        currentLayer: 4,
        totalLayer: 20,
        printDuration: 3660,
        estimatedRemainingSeconds: 120,
      }),
    ).toEqual({
      filename: 'part.gcode',
      layer: '4/20',
      elapsed: '1 h 1 min',
      remaining: '0 h 2 min',
    })
  })
  it('hides missing values and preserves zero', () => {
    expect(
      farmJobView({
        printerKey: 'p',
        state: 'offline',
        observedAt: 0,
        currentLayer: 0,
      }),
    ).toEqual({
      filename: undefined,
      layer: undefined,
      elapsed: undefined,
      remaining: undefined,
    })
    expect(formatJobTime(0)).toBe('0 h 0 min')
  })
})
