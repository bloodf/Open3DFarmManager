import type { ResinLedgerRecord } from './record.ts'

type Source = 'manual' | 'reported'
export interface Reading<T> {
  value: T
  source: Source
  recordedAt: number
}
export interface ResinLedgerSummary {
  /** Current vat: the latest vat change. Null when none was ever recorded. */
  vat: { name: string; source: Source; recordedAt: number } | null
  /** Latest volume reading for the current vat. Value is null while unknown. */
  vatVolumeMl: Reading<number> | null
  /** One row per bottle name; volumeMl is null while the volume is unknown. */
  bottles: {
    name: string
    volumeMl: number | null
    source: Source
    recordedAt: number
  }[]
  film: Reading<number> | null
  lcd: Reading<number> | null
}

/**
 * Folds ledger records (newest first) into the current state. Nothing is
 * inferred: a bottle recorded without a volume, or a counter never recorded,
 * stays unknown (null) and is never reported as zero.
 */
export function summarizeResinLedger(
  records: readonly ResinLedgerRecord[],
): ResinLedgerSummary {
  const newest = [...records].sort((a, b) => b.recordedAt - a.recordedAt)
  const summary: ResinLedgerSummary = {
    vat: null,
    vatVolumeMl: null,
    bottles: [],
    film: null,
    lcd: null,
  }
  const volumes: { name: string; reading: Reading<number> }[] = []
  const bottles = new Map<string, ResinLedgerSummary['bottles'][number]>()
  for (const { entry, recordedAt } of newest) {
    const source = entry.source
    if (entry.kind === 'vat') {
      summary.vat ??= { name: entry.name, source, recordedAt }
    } else if (entry.kind === 'film') {
      summary.film ??= { value: entry.layers, source, recordedAt }
    } else if (entry.kind === 'lcd') {
      summary.lcd ??= { value: entry.hours, source, recordedAt }
    } else if (entry.kind === 'bottle') {
      if (!bottles.has(entry.name))
        bottles.set(entry.name, {
          name: entry.name,
          volumeMl: entry.volumeMl,
          source,
          recordedAt,
        })
    } else if (entry.target === 'bottle') {
      if (!bottles.has(entry.name))
        bottles.set(entry.name, {
          name: entry.name,
          volumeMl: entry.volumeMl,
          source,
          recordedAt,
        })
    } else {
      volumes.push({
        name: entry.name,
        reading: { value: entry.volumeMl, source, recordedAt },
      })
    }
  }
  const current = summary.vat?.name
  summary.vatVolumeMl =
    volumes.find((volume) => volume.name === current)?.reading ?? null
  summary.bottles = [...bottles.values()].sort((a, b) =>
    a.name.localeCompare(b.name, 'pt-BR'),
  )
  return summary
}
