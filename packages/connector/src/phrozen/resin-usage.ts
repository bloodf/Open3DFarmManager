import { createHash, randomUUID } from 'node:crypto'
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
import { dirname } from 'node:path'
import { z } from 'zod'
import type { PhrozenTaskUsage } from './operations.ts'

/**
 * Debits the printer-reported volume of a finished run from the resin ledger,
 * at most once per run key.
 *
 * The existing ledger (apps/farm/server/utils/resin-ledger/entry.ts) has no
 * consumption entry. Its `volume` entry is the volume left in a vat, and the
 * summary takes the latest one. So a debit appends "last vat reading minus
 * reported usage", and only when that subtraction is known to be complete.
 * Anything else is `unknown`: nothing is appended and nothing is estimated.
 *
 * Journal statuses:
 * - `pending`: the append is about to be sent or is in flight.
 * - `applied`: the ledger confirmed it.
 * - `uncertain`: it may or may not be stored. Never retried; an operator
 *   settles it with `resolveUncertain`. A restart turns `pending` into this.
 * - `rejected`: the ledger definitely refused it. Not retried.
 * - `unknown`: no debit. Only `usage-missing` can be replaced, by a later
 *   report that carries a volume.
 */
const STATUSES = [
  'pending',
  'applied',
  'uncertain',
  'rejected',
  'unknown',
] as const
// Keys are never evicted: forgetting one would allow a second debit.
const MAX_ENTRIES = 10_000
const time = z.number().int().nonnegative()
const Entry = z.strictObject({
  key: z.string().regex(/^[0-9a-f]{64}$/),
  printerKey: z.string().min(1).max(128),
  board: z.string().min(1).max(64),
  taskId: z.string().min(1).max(128),
  status: z.enum(STATUSES),
  reason: z.string().max(64).nullable(),
  usedMl: z.number().finite().positive().nullable(),
  remainingMl: z.number().finite().nonnegative().nullable(),
  endedAt: time,
  updatedAt: time,
})
export type PhrozenResinEntry = z.infer<typeof Entry>
const Document = z.strictObject({
  version: z.literal(1),
  entries: z.array(Entry).max(MAX_ENTRIES),
})

export type PhrozenVatReading = Readonly<{
  vatName: string
  volumeMl: number
  /** Later of the vat change and its volume reading, in epoch milliseconds. */
  recordedAt: number
}>

/** Shape of the existing ledger's reported vat-volume entry. */
export type PhrozenVatVolumeEntry = {
  kind: 'volume'
  target: 'vat'
  name: string
  volumeMl: number
  source: 'reported'
}

export interface PhrozenResinLedger {
  /** Current vat and its latest volume; null when either is unknown. */
  vatReading(printerKey: string): Promise<PhrozenVatReading | null>
  /** True: stored. False: definitely not stored. A throw means unknown. */
  record(printerKey: string, entry: PhrozenVatVolumeEntry): Promise<boolean>
}

/** One run on one physical printer, even if its printer key is rebound. */
export function phrozenRunKey(board: string, taskId: string): string {
  return createHash('sha256')
    .update(JSON.stringify(['phrozen', board.toLowerCase(), taskId]))
    .digest('hex')
}

export type PhrozenResinOutcome =
  | (PhrozenResinEntry & { duplicate: boolean })
  /** The run is not final or has no identity; nothing was journaled. */
  | { status: 'deferred'; reason: 'run-not-settled' | 'run-unidentified' }

export function openPhrozenResinAccounting(input: {
  path: string
  ledger: PhrozenResinLedger
  timeoutMs?: number
  now?: () => number
}) {
  const { path, ledger } = input
  const now = input.now ?? Date.now
  const timeoutMs = input.timeoutMs ?? 10_000
  let entries = new Map<string, PhrozenResinEntry>()

  /** Durable before visible: temp file, fsync, rename. */
  function save(entry: PhrozenResinEntry) {
    const next = new Map(entries).set(entry.key, Entry.parse(entry))
    persist(next)
    entries = next
    return entry
  }
  function persist(next: Map<string, PhrozenResinEntry>) {
    const document = Document.parse({ version: 1, entries: [...next.values()] })
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

  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) {
    const parsed = Document.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    if (!parsed.success) throw new Error('Invalid Phrozen resin journal')
    for (const entry of parsed.data.entries) entries.set(entry.key, entry)
    for (const entry of parsed.data.entries)
      if (entry.status === 'pending')
        save({
          ...entry,
          status: 'uncertain',
          reason: 'restart-while-pending',
          updatedAt: now(),
        })
  }

  async function append(
    printerKey: string,
    entry: PhrozenVatVolumeEntry,
  ): Promise<[PhrozenResinEntry['status'], string | null]> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const stored = await Promise.race([
        ledger.record(printerKey, entry),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), timeoutMs)
        }),
      ])
      if (stored === true) return ['applied', null]
      if (stored === false) return ['rejected', 'ledger-refused']
      return ['uncertain', 'ledger-reply-malformed']
    } catch {
      return ['uncertain', 'response-lost']
    } finally {
      clearTimeout(timer)
    }
  }

  async function account(
    printerKey: string,
    usage: PhrozenTaskUsage,
  ): Promise<PhrozenResinOutcome> {
    const { board, taskId, beginTime, endTime, volumeMl } = usage
    if (!taskId) return { status: 'deferred', reason: 'run-unidentified' }
    if (usage.status === 'unsettled' || endTime === null)
      return { status: 'deferred', reason: 'run-not-settled' }
    const key = phrozenRunKey(board, taskId)
    const existing = entries.get(key)
    if (existing && !(existing.reason === 'usage-missing' && volumeMl !== null))
      return { ...existing, duplicate: true }
    if (!existing && entries.size >= MAX_ENTRIES)
      throw new Error('Phrozen resin journal is full')

    const claim: PhrozenResinEntry = {
      key,
      printerKey,
      board: board.toLowerCase(),
      taskId,
      status: 'unknown',
      reason: null,
      usedMl: volumeMl,
      remainingMl: null,
      endedAt: endTime,
      updatedAt: now(),
    }
    const unknown = (reason: string) => ({
      ...save({ ...claim, reason }),
      duplicate: false,
    })
    if (volumeMl === null) return unknown('usage-missing')
    if (beginTime === null) return unknown('run-time-missing')
    // A failed read throws here, before any claim: nothing was sent.
    const reading = await ledger.vatReading(printerKey)
    if (!reading) return unknown('vat-reading-missing')
    // A reading taken during or after the run may already include its usage.
    if (!(reading.recordedAt < beginTime))
      return unknown('reading-not-before-run')
    // An earlier run that never reached the ledger leaves the reading stale.
    if (
      [...entries.values()].some(
        (other) =>
          other.key !== key &&
          other.board === claim.board &&
          other.status !== 'applied' &&
          other.endedAt > reading.recordedAt,
      )
    )
      return unknown('prior-usage-unaccounted')
    if (volumeMl > reading.volumeMl) return unknown('usage-exceeds-reading')

    const remainingMl = Number((reading.volumeMl - volumeMl).toFixed(6))
    const pending = save({ ...claim, status: 'pending', remainingMl })
    const [status, reason] = await append(printerKey, {
      kind: 'volume',
      target: 'vat',
      name: reading.vatName,
      volumeMl: remainingMl,
      source: 'reported',
    })
    return {
      ...save({ ...pending, status, reason, updatedAt: now() }),
      duplicate: false,
    }
  }

  let queue: Promise<unknown> = Promise.resolve()
  return {
    /** Serialized, so two runs never subtract from the same reading. */
    recordRun(
      printerKey: string,
      usage: PhrozenTaskUsage,
    ): Promise<PhrozenResinOutcome> {
      const result = queue.then(() => account(printerKey, usage))
      queue = result.catch(() => undefined)
      return result
    },
    list: (status?: PhrozenResinEntry['status']) =>
      [...entries.values()].filter((e) => !status || e.status === status),
    /** For an operator who has checked the ledger. Sends nothing. */
    resolveUncertain(key: string, outcome: 'applied' | 'rejected') {
      const entry = entries.get(key)
      if (entry?.status !== 'uncertain')
        throw new Error('Only an uncertain resin entry can be resolved')
      return save({
        ...entry,
        status: outcome,
        reason: 'operator-reconciled',
        updatedAt: now(),
      })
    },
  }
}
export type PhrozenResinAccounting = ReturnType<
  typeof openPhrozenResinAccounting
>
