import { describe, expect, test } from 'vitest'
import { resinLedgerEntry } from '../../apps/farm/server/utils/resin-ledger/entry.ts'

// spec-derived, not captured: https://github.com/bloodf/openfarm-farm/blob/main/docs/fullfarmmanager/REVIEW.md

describe('resin ledger entries', () => {
  test('keeps vat changes and volume adjustments explicit', () => {
    expect(
      resinLedgerEntry.parse({ kind: 'vat', name: 'Cuba B', source: 'manual' }),
    ).toEqual({ kind: 'vat', name: 'Cuba B', source: 'manual' })
    expect(
      resinLedgerEntry.parse({
        kind: 'volume',
        target: 'vat',
        name: 'Cuba B',
        volumeMl: 125,
        source: 'manual',
      }),
    ).toEqual({
      kind: 'volume',
      target: 'vat',
      name: 'Cuba B',
      volumeMl: 125,
      source: 'manual',
    })
  })
  test('keeps film and LCD readings separate and preserves unknown bottle volume', () => {
    expect(
      resinLedgerEntry.parse({ kind: 'film', layers: 50, source: 'reported' }),
    ).toEqual({ kind: 'film', layers: 50, source: 'reported' })
    expect(
      resinLedgerEntry.parse({ kind: 'lcd', hours: 12.5, source: 'manual' }),
    ).toEqual({ kind: 'lcd', hours: 12.5, source: 'manual' })
    expect(
      resinLedgerEntry.parse({
        kind: 'bottle',
        name: 'A',
        volumeMl: null,
        source: 'manual',
      }),
    ).toEqual({ kind: 'bottle', name: 'A', volumeMl: null, source: 'manual' })
    expect(
      resinLedgerEntry.safeParse({
        kind: 'film',
        layers: 3,
        hours: 1,
        source: 'reported',
      }).success,
    ).toBe(false)
    expect(
      resinLedgerEntry.safeParse({
        kind: 'volume',
        target: 'vat',
        name: 'A',
        volumeMl: -1,
        source: 'manual',
      }).success,
    ).toBe(false)
  })
})
