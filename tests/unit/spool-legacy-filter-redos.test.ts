import { describe, expect, it } from 'vitest'
import { stringFilter } from '../../apps/farm/server/utils/spool-library/legacy-api/listing.ts'

describe('Spoolman legacy string filters', () => {
  it('matches a many-wildcard term against a long value in under 100 ms', () => {
    const matches = stringFilter(`${'%'.repeat(12)}z`, false)!
    const start = performance.now()
    expect(matches('x'.repeat(40))).toBe(false)
    expect(performance.now() - start).toBeLessThan(100)
  })

  it('keeps case-insensitive substring matching for ordinary terms', () => {
    expect(stringFilter('PLA', false)!('Black PLA spool')).toBe(true)
    expect(stringFilter('pla', false)!('Black PLA spool')).toBe(true)
    expect(stringFilter('PETG', false)!('Black PLA spool')).toBe(false)
  })

  it('treats percent and underscore in terms literally', () => {
    expect(stringFilter('A%_B', false)!('spool A%_B blue')).toBe(true)
    expect(stringFilter('A%_B', false)!('spool AxxB blue')).toBe(false)
  })
})
