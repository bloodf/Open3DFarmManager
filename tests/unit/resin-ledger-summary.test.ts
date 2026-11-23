import { describe, expect, test } from 'vitest'
import {
  entryColumns,
  recordFromRow,
  type ResinLedgerRecord,
} from '../../apps/farm/server/utils/resin-ledger/record.ts'
import { summarizeResinLedger } from '../../apps/farm/server/utils/resin-ledger/summary.ts'
import {
  resinLedgerListQuery,
  resinLedgerRecordBody,
} from '../../apps/farm/server/utils/resin-ledger/request.ts'
import {
  emptyResinForm,
  resinEntryFromForm,
} from '../../apps/farm/app/components/resin/resin-form.ts'

const rec = (
  recordedAt: number,
  entry: ResinLedgerRecord['entry'],
): ResinLedgerRecord => ({ id: String(recordedAt), recordedAt, entry })

describe('resin ledger state', () => {
  test('unknown stays unknown: no records means null, not zero', () => {
    expect(summarizeResinLedger([])).toEqual({
      vat: null,
      vatVolumeMl: null,
      bottles: [],
      film: null,
      lcd: null,
    })
  })
  test('latest reading wins and keeps provenance; a later unknown bottle volume resets to unknown', () => {
    const summary = summarizeResinLedger([
      rec(1, { kind: 'vat', name: 'Cuba A', source: 'manual' }),
      rec(2, {
        kind: 'volume',
        target: 'vat',
        name: 'Cuba A',
        volumeMl: 300,
        source: 'manual',
      }),
      rec(3, {
        kind: 'volume',
        target: 'vat',
        name: 'Cuba Z',
        volumeMl: 9,
        source: 'manual',
      }),
      rec(4, { kind: 'bottle', name: 'B1', volumeMl: 500, source: 'manual' }),
      rec(5, {
        kind: 'volume',
        target: 'bottle',
        name: 'B1',
        volumeMl: 400,
        source: 'manual',
      }),
      rec(6, { kind: 'bottle', name: 'B1', volumeMl: null, source: 'manual' }),
      rec(7, { kind: 'film', layers: 10, source: 'reported' }),
      rec(8, { kind: 'film', layers: 25, source: 'reported' }),
      rec(9, { kind: 'lcd', hours: 1.5, source: 'manual' }),
    ])
    expect(summary.vat).toEqual({
      name: 'Cuba A',
      source: 'manual',
      recordedAt: 1,
    })
    expect(summary.vatVolumeMl).toEqual({
      value: 300,
      source: 'manual',
      recordedAt: 2,
    })
    expect(summary.bottles).toEqual([
      { name: 'B1', volumeMl: null, source: 'manual', recordedAt: 6 },
    ])
    expect(summary.film).toEqual({
      value: 25,
      source: 'reported',
      recordedAt: 8,
    })
    expect(summary.lcd?.value).toBe(1.5)
  })
  test('a vat volume belongs to its own vat: another vat leaves the volume unknown', () => {
    const summary = summarizeResinLedger([
      rec(1, {
        kind: 'volume',
        target: 'vat',
        name: 'Cuba Z',
        volumeMl: 9,
        source: 'manual',
      }),
      rec(2, { kind: 'vat', name: 'Cuba A', source: 'manual' }),
    ])
    expect(summary.vatVolumeMl).toBeNull()
  })
})

describe('resin ledger rows', () => {
  test('round-trips every kind through columns and back', () => {
    for (const entry of [
      { kind: 'vat', name: 'A', source: 'manual' },
      { kind: 'bottle', name: 'A', volumeMl: null, source: 'reported' },
      {
        kind: 'volume',
        target: 'bottle',
        name: 'A',
        volumeMl: 0,
        source: 'manual',
      },
      { kind: 'film', layers: 0, source: 'reported' },
      { kind: 'lcd', hours: 3, source: 'manual' },
    ] as const) {
      const columns = entryColumns(entry)
      expect(
        recordFromRow({ ...columns, id: 'x', recordedAt: 1 })?.entry,
      ).toEqual(entry)
    }
  })
  test('a null film reading is malformed, not zero', () => {
    expect(
      recordFromRow({
        ...entryColumns({ kind: 'film', layers: 1, source: 'manual' }),
        layers: null,
        id: 'x',
        recordedAt: 1,
      }),
    ).toBeNull()
  })
})

describe('resin ledger requests', () => {
  const farmId = '11111111-1111-4111-8111-111111111111'
  test('accounts may only write manual entries and cannot smuggle extra fields', () => {
    const entry = { kind: 'film', layers: 3, source: 'manual' }
    expect(
      resinLedgerRecordBody.safeParse({ farmId, printerKey: 'k', entry })
        .success,
    ).toBe(true)
    expect(
      resinLedgerRecordBody.safeParse({
        farmId,
        printerKey: 'k',
        entry: { ...entry, source: 'reported' },
      }).success,
    ).toBe(false)
    expect(
      resinLedgerRecordBody.safeParse({
        farmId,
        printerKey: 'k',
        entry,
        extra: 1,
      }).success,
    ).toBe(false)
    expect(
      resinLedgerListQuery.safeParse({ farmId: 'nope', printerKey: 'k' })
        .success,
    ).toBe(false)
  })
  test('form: blank bottle volume is unknown, blank counters are rejected', () => {
    const bottle = resinEntryFromForm({
      ...emptyResinForm(),
      kind: 'bottle',
      name: 'A',
    })
    expect(bottle).toEqual({
      ok: true,
      entry: { kind: 'bottle', name: 'A', volumeMl: null, source: 'manual' },
    })
    expect(resinEntryFromForm({ ...emptyResinForm(), kind: 'film' }).ok).toBe(
      false,
    )
    expect(
      resinEntryFromForm({ ...emptyResinForm(), kind: 'volume', name: 'A' }).ok,
    ).toBe(false)
    expect(
      resinEntryFromForm({ ...emptyResinForm(), kind: 'lcd', hours: '2,5' }),
    ).toEqual({
      ok: true,
      entry: { kind: 'lcd', hours: 2.5, source: 'manual' },
    })
  })
})
