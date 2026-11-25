import { describe, expect, it } from 'vitest'
import { resolveSpoolLevel } from '../../apps/farm/app/utils/spool-level.ts'

const unknown = { kind: 'unknown' }

describe('resolveSpoolLevel', () => {
  it('uses the Spoolman weights first, even when the printer disagrees', () => {
    expect(
      resolveSpoolLevel({
        spoolmanRemainingWeight: 250,
        spoolmanInitialWeight: 1000,
        printerPercent: 90,
      }),
    ).toEqual({ kind: 'known', fraction: 0.25, source: 'spoolman' })
  })

  it('falls back to the printer percentage when Spoolman has no usable weights', () => {
    for (const weights of [
      {},
      { spoolmanRemainingWeight: 250 },
      { spoolmanInitialWeight: 1000 },
      { spoolmanRemainingWeight: null, spoolmanInitialWeight: null },
      { spoolmanRemainingWeight: 250, spoolmanInitialWeight: 0 },
      { spoolmanRemainingWeight: 250, spoolmanInitialWeight: -1000 },
      { spoolmanRemainingWeight: Number.NaN, spoolmanInitialWeight: 1000 },
    ]) {
      expect(resolveSpoolLevel({ ...weights, printerPercent: 40 })).toEqual({
        kind: 'known',
        fraction: 0.4,
        source: 'printer',
      })
    }
  })

  it('is unknown when both sources are missing', () => {
    expect(resolveSpoolLevel({})).toEqual(unknown)
    expect(
      resolveSpoolLevel({
        spoolmanRemainingWeight: null,
        spoolmanInitialWeight: null,
        printerPercent: null,
      }),
    ).toEqual(unknown)
    expect(resolveSpoolLevel({ printerPercent: Number.NaN })).toEqual(unknown)
    expect(resolveSpoolLevel({ printerPercent: Infinity })).toEqual(unknown)
  })

  it('keeps zero as a real empty spool, from either source', () => {
    expect(
      resolveSpoolLevel({
        spoolmanRemainingWeight: 0,
        spoolmanInitialWeight: 1000,
      }),
    ).toEqual({ kind: 'known', fraction: 0, source: 'spoolman' })
    expect(resolveSpoolLevel({ printerPercent: 0 })).toEqual({
      kind: 'known',
      fraction: 0,
      source: 'printer',
    })
  })

  it('does not turn a negative reading into a level', () => {
    expect(
      resolveSpoolLevel({
        spoolmanRemainingWeight: -12,
        spoolmanInitialWeight: 1000,
      }),
    ).toEqual(unknown)
    expect(
      resolveSpoolLevel({
        spoolmanRemainingWeight: -12,
        spoolmanInitialWeight: 1000,
        printerPercent: 55,
      }),
    ).toEqual({ kind: 'known', fraction: 0.55, source: 'printer' })
    expect(resolveSpoolLevel({ printerPercent: -1 })).toEqual(unknown)
  })

  it('rejects printer percentages above 100 instead of clamping them', () => {
    expect(resolveSpoolLevel({ printerPercent: 100 })).toEqual({
      kind: 'known',
      fraction: 1,
      source: 'printer',
    })
    expect(resolveSpoolLevel({ printerPercent: 101 })).toEqual(unknown)
    expect(resolveSpoolLevel({ printerPercent: 255 })).toEqual(unknown)
  })

  it('caps a Spoolman spool heavier than its initial weight at full', () => {
    expect(
      resolveSpoolLevel({
        spoolmanRemainingWeight: 1080,
        spoolmanInitialWeight: 1000,
      }),
    ).toEqual({ kind: 'known', fraction: 1, source: 'spoolman' })
  })
})
