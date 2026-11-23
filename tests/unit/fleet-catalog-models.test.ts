// spec-derived, not captured: https://github.com/cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0/blob/main/SDCP%28Smart%20Device%20Control%20Protocol%29_V3.0.0_EN.md
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fleetCatalog } from '../../apps/farm/app/utils/compatibility/fleet-catalog'

describe('reviewed fleet catalog', () => {
  it('includes every verdict with the correct technology', () => {
    const review = readFileSync('docs/fullfarmmanager/REVIEW.md', 'utf8')
      .split('## Model verdicts')[1]!
      .split('## Snapshot checks')[0]!
    const verdicts = review
      .split('\n')
      .map((line) => line.split('|').map((cell) => cell.trim()))
      .filter((cells) => cells[3] === 'fdm' || cells[3] === 'resin')
    expect(verdicts.length).toBeGreaterThan(0)
    for (const row of verdicts) {
      expect(
        fleetCatalog.find(
          (item) => item.brand === row[1] && item.model === row[2],
        )?.kind,
      ).toBe(row[3])
    }
  })
  it('distinguishes grades, preserves unknowns and requires sources', () => {
    expect(
      new Set(fleetCatalog.flatMap((item) => [item.grade, item.protocolGrade])),
    ).toEqual(
      new Set([
        'hardware-qualified',
        'documented',
        'spec-derived',
        'unverified',
      ]),
    )
    expect(
      fleetCatalog.find((item) => item.model === 'Kobra 3 Max V2')?.network,
    ).toContain('unverified')
    for (const item of fleetCatalog) {
      expect(item.sources.length).toBeGreaterThan(0)
      for (const capability of item.capabilities)
        expect(capability.sources.length).toBeGreaterThan(0)
      if (item.kind === 'resin') expect(item.capabilities).toEqual([])
    }
  })
})
