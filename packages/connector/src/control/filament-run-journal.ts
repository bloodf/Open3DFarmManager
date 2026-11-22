import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { z } from 'zod'

/**
 * Connector-local durable journal of filament debits, one entry per run
 * attempt and tool. Spoolman has no atomic idempotent debit, so the key lives
 * here: an entry is written as `pending` before the use call and finished after
 * it, and a key that already has an entry is never debited again.
 *
 * - `pending`: a debit is about to be sent or is in flight.
 * - `applied`: Spoolman confirmed the debit.
 * - `uncertain`: the debit may or may not have been applied. Never retried
 *   automatically; an operator reconciles it with {@link resolveUncertain}.
 * - `rejected`: Spoolman definitely refused the debit. Not retried automatically.
 * - `unknown`: usage or attribution is unknown. No debit, nothing guessed.
 * - `record-only`: the printer already reports usage to Spoolman; only the
 *   attribution is recorded.
 */
export const FILAMENT_ENTRY_STATUSES = [
  'pending',
  'applied',
  'uncertain',
  'rejected',
  'unknown',
  'record-only',
] as const
export type FilamentEntryStatus = (typeof FILAMENT_ENTRY_STATUSES)[number]

const MAX_ENTRIES = 20_000
const time = z.number().int().nonnegative()
const Entry = z.strictObject({
  key: z.string().regex(/^[0-9a-f]{64}$/),
  printerKey: z.string().min(1).max(128),
  tool: z.string().min(1).max(32),
  spoolId: z.number().int().positive().nullable(),
  status: z.enum(FILAMENT_ENTRY_STATUSES),
  reason: z.string().max(64).nullable(),
  grams: z.number().finite().positive().nullable(),
  millimetres: z.number().finite().positive().nullable(),
  createdAt: time,
  updatedAt: time,
})
export type FilamentRunEntry = z.infer<typeof Entry>
const Document = z.strictObject({
  version: z.literal(1),
  entries: z.array(Entry).max(MAX_ENTRIES),
})

export type FilamentClaim = Omit<FilamentRunEntry, 'createdAt' | 'updatedAt'>
export type FilamentClaimResult =
  | { claimed: true; entry: FilamentRunEntry }
  | { claimed: false; entry: FilamentRunEntry }

export interface FilamentRunJournal {
  /**
   * Record a new entry, synchronously and durably. Returns `claimed: false`
   * with the existing entry for a repeated key. The one exception is an
   * `unknown` entry whose usage was missing: a later event that carries
   * measured usage may replace it, since nothing was debited.
   */
  claim(input: FilamentClaim): FilamentClaimResult
  finish(
    key: string,
    status: Exclude<FilamentEntryStatus, 'pending'>,
    reason?: string,
  ): FilamentRunEntry
  get(key: string): FilamentRunEntry | undefined
  list(status?: FilamentEntryStatus): FilamentRunEntry[]
  /**
   * Operator reconciliation of an `uncertain` entry after checking the spool in
   * Spoolman: `applied` (the weight was debited) or `rejected` (it was not).
   */
  resolveUncertain(
    key: string,
    outcome: 'applied' | 'rejected',
  ): FilamentRunEntry
}

function persist(path: string, entries: Map<string, FilamentRunEntry>): void {
  const document = Document.parse({
    version: 1,
    entries: [...entries.values()],
  })
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  const fd = openSync(temp, 'wx', 0o600)
  try {
    writeSync(fd, `${JSON.stringify(document)}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temp, path)
}

/** Opens (or creates) the journal. A `pending` entry found on open was in flight when the process stopped, so it becomes `uncertain`. */
export function openFilamentRunJournal(input: {
  path: string
  now?: () => number
}): FilamentRunJournal {
  const { path } = input
  const now = input.now ?? Date.now
  const entries = new Map<string, FilamentRunEntry>()
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) {
    const parsed = Document.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    if (!parsed.success) throw new Error('Invalid filament run journal')
    for (const entry of parsed.data.entries) entries.set(entry.key, entry)
    let changed = false
    for (const [key, entry] of entries)
      if (entry.status === 'pending') {
        entries.set(key, {
          ...entry,
          status: 'uncertain',
          reason: 'restart-while-pending',
          updatedAt: now(),
        })
        changed = true
      }
    if (changed) persist(path, entries)
  }

  function save(next: Map<string, FilamentRunEntry>): void {
    persist(path, next)
    entries.clear()
    for (const [key, entry] of next) entries.set(key, entry)
  }
  function evictTerminal(next: Map<string, FilamentRunEntry>): void {
    if (next.size < MAX_ENTRIES) return
    // Oldest settled entries only; pending and uncertain entries must survive.
    const victims = [...next.values()]
      .filter((entry) => !['pending', 'uncertain'].includes(entry.status))
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, Math.max(1, Math.floor(MAX_ENTRIES / 20)))
    if (victims.length === 0) throw new Error('Filament run journal is full')
    for (const victim of victims) next.delete(victim.key)
  }

  return {
    claim(claim) {
      const existing = entries.get(claim.key)
      if (
        existing &&
        !(
          existing.status === 'unknown' &&
          existing.reason === 'usage-missing' &&
          claim.status !== 'unknown'
        )
      )
        return { claimed: false, entry: existing }
      const at = now()
      const entry = Entry.parse({
        ...claim,
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
      })
      const next = new Map(entries)
      evictTerminal(next)
      next.set(entry.key, entry)
      save(next)
      return { claimed: true, entry }
    },
    finish(key, status, reason) {
      const existing = entries.get(key)
      if (!existing) throw new Error('Unknown filament run entry')
      const entry = Entry.parse({
        ...existing,
        status,
        reason: reason ?? null,
        updatedAt: now(),
      })
      const next = new Map(entries)
      next.set(key, entry)
      save(next)
      return entry
    },
    get: (key) => entries.get(key),
    list: (status) =>
      [...entries.values()].filter((e) => !status || e.status === status),
    resolveUncertain(key, outcome) {
      const existing = entries.get(key)
      if (existing?.status !== 'uncertain')
        throw new Error('Only an uncertain filament run entry can be resolved')
      return this.finish(key, outcome, 'operator-reconciled')
    },
  }
}
