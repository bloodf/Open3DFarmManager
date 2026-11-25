import {
  resinLedgerEntry,
  type ResinLedgerEntry,
} from '../../../common/resin-ledger/entry.ts'

/** Column values for farm.resin_ledger_entries. Absent readings are NULL, never 0. */
export interface ResinLedgerColumns {
  kind: ResinLedgerEntry['kind']
  target: string | null
  name: string | null
  volumeMl: number | null
  layers: number | null
  hours: number | null
  source: ResinLedgerEntry['source']
}

export function entryColumns(entry: ResinLedgerEntry): ResinLedgerColumns {
  const base = {
    target: null,
    name: null,
    volumeMl: null,
    layers: null,
    hours: null,
  }
  switch (entry.kind) {
    case 'vat':
      return { ...base, kind: 'vat', name: entry.name, source: entry.source }
    case 'bottle':
      return {
        ...base,
        kind: 'bottle',
        name: entry.name,
        volumeMl: entry.volumeMl,
        source: entry.source,
      }
    case 'volume':
      return {
        ...base,
        kind: 'volume',
        target: entry.target,
        name: entry.name,
        volumeMl: entry.volumeMl,
        source: entry.source,
      }
    case 'film':
      return {
        ...base,
        kind: 'film',
        layers: entry.layers,
        source: entry.source,
      }
    case 'lcd':
      return { ...base, kind: 'lcd', hours: entry.hours, source: entry.source }
  }
}

export interface ResinLedgerRecord {
  id: string
  recordedAt: number
  entry: ResinLedgerEntry
}

export interface ResinLedgerRow extends ResinLedgerColumns {
  id: string
  recordedAt: number
}

/** Rebuilds a validated entry from a stored row; a malformed row yields null. */
export function recordFromRow(row: ResinLedgerRow): ResinLedgerRecord | null {
  const parsed = resinLedgerEntry.safeParse(
    row.kind === 'vat'
      ? { kind: 'vat', name: row.name, source: row.source }
      : row.kind === 'bottle'
        ? {
            kind: 'bottle',
            name: row.name,
            volumeMl: row.volumeMl,
            source: row.source,
          }
        : row.kind === 'volume'
          ? {
              kind: 'volume',
              target: row.target,
              name: row.name,
              volumeMl: row.volumeMl,
              source: row.source,
            }
          : row.kind === 'film'
            ? { kind: 'film', layers: row.layers, source: row.source }
            : { kind: 'lcd', hours: row.hours, source: row.source },
  )
  return parsed.success
    ? { id: row.id, recordedAt: row.recordedAt, entry: parsed.data }
    : null
}
