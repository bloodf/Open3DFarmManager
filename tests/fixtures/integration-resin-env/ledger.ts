// spec-derived, not captured: https://github.com/bloodf/Open3DFarmManager/issues/683
// Contract fixture for manual vs measured resin values. No resin printer or
// sensor was queried: the rows below follow the farm.resin_ledger_entries
// schema (migration 0092) and the issue's rule that unknown stays unknown.
import type { ResinLedgerRecord } from '../../../apps/farm/server/utils/resin-ledger/record.ts'

export const farmA = '11111111-1111-4111-8111-111111111111'
export const farmB = '22222222-2222-4222-8222-222222222222'
export const printerA1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
export const printerA2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
export const printerB1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'

let n = 0
const record = (
  recordedAt: number,
  entry: ResinLedgerRecord['entry'],
): ResinLedgerRecord => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  recordedAt,
  entry,
})

/** Newest first, as the reader returns them. */
export const printerA1Records: ResinLedgerRecord[] = [
  // Measured level for the current vat, after the vat change.
  record(5_000, {
    kind: 'volume',
    target: 'vat',
    name: 'Vat-1',
    volumeMl: 410,
    source: 'reported',
  }),
  // Bottle recorded by an operator without a volume: unknown, not zero.
  record(4_000, {
    kind: 'bottle',
    name: 'Lote-B7',
    volumeMl: null,
    source: 'manual',
  }),
  // Manual bottle reading.
  record(3_000, {
    kind: 'bottle',
    name: 'Lote-A1',
    volumeMl: 750,
    source: 'manual',
  }),
  record(2_000, { kind: 'vat', name: 'Vat-1', source: 'manual' }),
  // Reading of the previous vat, after its own change.
  record(1_500, {
    kind: 'volume',
    target: 'vat',
    name: 'Vat-0',
    volumeMl: 90,
    source: 'manual',
  }),
  record(1_000, { kind: 'vat', name: 'Vat-0', source: 'manual' }),
]

export const printerA2Records: ResinLedgerRecord[] = [
  record(7_000, { kind: 'vat', name: 'Vat-X', source: 'reported' }),
  // Taken before Vat-X was last recorded: it must not carry over to the new vat.
  record(6_500, {
    kind: 'volume',
    target: 'vat',
    name: 'Vat-X',
    volumeMl: 300,
    source: 'manual',
  }),
]

export const printerB1Records: ResinLedgerRecord[] = [
  record(8_000, {
    kind: 'bottle',
    name: 'Lote-Z9',
    volumeMl: 500,
    source: 'manual',
  }),
]

export const expectedLotsA1 = [
  {
    lotRef: 'Lote-A1',
    quantity: 750,
    unit: 'ml',
    quantityState: 'known',
    source: 'manual',
    observedAt: 3_000,
  },
  {
    lotRef: 'Lote-B7',
    quantity: null,
    unit: 'ml',
    quantityState: 'unknown',
    source: 'manual',
    observedAt: 4_000,
  },
]

export const expectedVatsA1 = [
  {
    vatRef: 'Vat-0',
    current: false,
    quantity: 90,
    unit: 'ml',
    quantityState: 'known',
    source: 'manual',
    observedAt: 1_500,
  },
  {
    vatRef: 'Vat-1',
    current: true,
    quantity: 410,
    unit: 'ml',
    quantityState: 'known',
    source: 'measured',
    observedAt: 5_000,
  },
]
