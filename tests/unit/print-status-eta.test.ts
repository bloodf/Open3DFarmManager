import { expect, it } from 'vitest'
import { printStatusEta } from '../../apps/farm/app/components/printer-detail/print-status-eta.ts'

it.each([
  [
    {
      elapsed: 100,
      progress: 0.25,
      estimatedSeconds: 480,
      filamentUsed: 200,
      filamentTotal: 600,
      speed: 1.2,
    },
    { file: 300, slicer: 300, filament: 200 },
  ],
  [
    {
      elapsed: 100,
      progress: 1,
      estimatedSeconds: 100,
      filamentUsed: 600,
      filamentTotal: 600,
    },
    { file: 0, slicer: 0, filament: 0 },
  ],
  [
    { elapsed: 0, progress: 0, estimatedSeconds: 500 },
    { file: null, slicer: 500, filament: null },
  ],
  [
    { elapsed: 200, estimatedSeconds: 600, speed: 2 },
    { file: null, slicer: 100, filament: null },
  ],
  [
    {
      elapsed: 100,
      progress: 2,
      estimatedSeconds: NaN,
      filamentUsed: 700,
      filamentTotal: 600,
    },
    { file: null, slicer: null, filament: null },
  ],
  [{ elapsed: 100 }, { file: null, slicer: null, filament: null }],
])('calculates remaining seconds for %j', (input, expected) => {
  expect(printStatusEta(input)).toEqual(expected)
})
