import { describe, expect, it } from 'vitest'
import {
  formatDateTime,
  formatDuration,
  formatPercentage,
  formatTemperature,
  formatWeight,
} from '../../apps/farm/app/utils/ui-format'

describe('pt-BR UI formatting', () => {
  it('formats dates in São Paulo even across midnight UTC', () => {
    const iso = '2026-11-20T01:02:03Z'
    expect(formatDateTime(iso)).toBe('19/11/2026, 22:02:03')
    expect(formatDateTime(Date.parse(iso))).toBe(formatDateTime(iso))
    expect(formatDateTime(new Date(iso))).toBe(formatDateTime(iso))
    expect(formatDateTime('invalid')).toBeUndefined()
  })

  it('formats elapsed whole minutes and carries minutes into hours', () => {
    expect(formatDuration(59)).toBe('0 min')
    expect(formatDuration(3599)).toBe('59 min')
    expect(formatDuration(3600)).toBe('1 h 0 min')
    expect(formatDuration(3661)).toBe('1 h 1 min')
    expect(formatDuration(-1)).toBeUndefined()
    expect(formatDuration(Infinity)).toBeUndefined()
  })

  it('formats measurements with localized decimals and units', () => {
    expect(formatTemperature(-2.54)).toBe('-2,5 °C')
    expect(formatWeight(1250.25)).toBe('1.250,3 g')
    expect(formatPercentage(12.34)).toBe('12,3%')
    expect(formatPercentage(0)).toBe('0%')
    expect(formatPercentage(100)).toBe('100%')
    expect(formatTemperature(NaN)).toBeUndefined()
    expect(formatWeight(-1)).toBeUndefined()
    expect(formatPercentage(Infinity)).toBeUndefined()
  })
})
