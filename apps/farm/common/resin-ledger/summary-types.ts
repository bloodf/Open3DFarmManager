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
